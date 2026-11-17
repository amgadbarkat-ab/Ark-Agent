/**
 * BlackArk phone relay (#109): carries a phone call between Twilio and the ArkAgent install that
 * answers that line.
 *
 * WHY IT EXISTS. The install sits behind the customer's router, so the phone network cannot reach it.
 * Twilio calls this relay instead; the install keeps one outgoing WebSocket open to it (`/line`),
 * and the relay passes the call's audio both ways.
 *
 * WHAT IT HOLDS. Nothing about the conversation: no audio, no transcript, no speech key. The speech
 * service is dialled by the install with the customer's own key. The relay keeps, in memory only,
 * which install is connected for which line and which calls are live. Its log lines carry the call
 * id, the line's name and the duration, never a caller's number.
 *
 * WHAT IT TRUSTS.
 * - Twilio's webhooks only with a valid `X-Twilio-Signature` (HMAC-SHA1 with the account's auth
 *   token over the public URL and the form fields).
 * - Twilio's media socket only with the one-time key the signed webhook handed out for that call.
 * - An install only with its line token, compared by SHA-256 against the lines file.
 * - The number a call is handed over to comes from the lines file, never from the install.
 *
 * PREPAID BALANCE (v0.1.47; Amgad 17 Nov). A line with a `customerId` is paid from that customer's
 * prepaid phone balance on blackark.uk (`BILLING_URL`, requests signed with `BILLING_SECRET`). The
 * balance never goes below zero: the relay sets each minute's cost aside before the minute starts,
 * across every live call of that customer, at the incoming rate plus the landline or mobile rate
 * once the caller is put through to a person. A call the balance cannot pay a first minute for is
 * not answered (busy, which Twilio does not bill); a call that cannot pay its next minute hears one
 * Greek sentence and ends before that minute starts. When blackark.uk cannot be reached, ONE call
 * per customer is answered on the last balance known (still ended before it would run out), then
 * callers hear busy until blackark.uk answers again, and BlackArk gets one internal alert per outage
 * (Amgad, 17 Nov 12:46: that call's cost beyond what is later booked is BlackArk's). When a call ends the
 * relay reports its parts and their seconds, never the caller's number, keyed by Twilio's call id so
 * a repeat is charged once, and passes the new balance to the install. A line without a
 * `customerId` (a demo or trial line) is not billed.
 *
 * ONE PROCESS. The relay is a single process by design (a few calls at once need 1 vCPU); its state
 * is per process. Run one copy per line set, not several behind a load balancer.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import { type SmtpConfig, sendMail } from "./smtp";

export type Line = {
  /** A short name for logs, e.g. "demo-shop". */
  name: string;
  /** The Twilio number calls arrive on, E.164, e.g. "+302101234567". */
  number: string;
  /** SHA-256 (hex) of the line token the install presents. */
  tokenSha256: string;
  /** Where a call goes when the install hands it over, or is not connected. E.164. Optional. */
  fallback?: string;
  /** The ArkAgent customer whose prepaid phone balance pays for this line. None: not billed. */
  customerId?: string;
};

/** Where the prepaid phone balance is kept (blackark.uk/checkin/phone/), and the shared secret. */
export type Billing = {
  url: string;
  secret: string;
  /** A minute, and how long before its end the next one is set aside or the call ended. For tests. */
  minuteMs?: number;
  marginMs?: number;
};

export type Rates = { incoming: number; landline: number; mobile: number };

/** The balance as blackark.uk answers it (mils, 1/1000 euro), and as the install is told. */
export type BalanceView = {
  customerId: string;
  balanceMils: number;
  state: "ok" | "low" | "empty";
  minutesLeftAtLeast: number;
  topUpUrl: string;
  rates: Rates;
};

export type CallPart = {
  kind: "incoming" | "landline" | "mobile";
  seconds: number;
};

export type RelayConfig = {
  accountSid: string;
  authToken: string;
  /** e.g. "https://phone.blackark.uk", with no trailing slash. */
  publicBaseUrl: string;
  lines: () => Line[];
  /** The prepaid phone balance. Without it no line is billed. */
  billing?: Billing;
  /** Twilio's REST API and blackark.uk, swapped in tests. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** BlackArk's internal alert (an email from its own mailbox). Without it, the alert is only logged. */
  alert?: (subject: string, body: string) => Promise<void>;
};

/** Desk → relay messages. Anything else is dropped. */
type DeskMessage =
  | { type: "media"; callId: string; payload: string }
  | { type: "clear"; callId: string }
  | { type: "mark"; callId: string; name: string }
  | { type: "transfer"; callId: string }
  | { type: "hangup"; callId: string };

type SocketData =
  | { kind: "desk"; line: Line }
  | { kind: "twilio"; callId?: string; streamSid?: string; line?: Line };

const E164 = /^\+[1-9]\d{6,14}$/;
const CALL_SID = /^CA[0-9a-f]{32}$/;
const MAX_FRAME = 64 * 1024;
const MAX_AUDIO_B64 = 16 * 1024;
const PENDING_MS = 30_000;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Twilio's request signature: HMAC-SHA1 over the URL then each form field, sorted, as key+value. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(body: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    {
      headers: { "content-type": "text/xml; charset=utf-8" },
    },
  );
}

/** Greek first: the callers are in Greece. */
const SORRY =
  '<Say language="el-GR">Λυπούμαστε, η γραμμή δεν είναι διαθέσιμη αυτή τη στιγμή. Παρακαλούμε καλέστε ξανά αργότερα.</Say><Hangup/>';

/** Dials the line's fallback. `action`, when billed, is where Twilio reports the forwarded minutes. */
function handOver(line: Line | undefined, action?: string): string {
  if (!line?.fallback || !E164.test(line.fallback)) return SORRY;
  return action
    ? `<Dial action="${xml(action)}">${xml(line.fallback)}</Dial>`
    : `<Dial>${xml(line.fallback)}</Dial>`;
}

/** Greek landlines start +302; anything else is charged at the mobile rate, the higher one. */
export function forwardKind(number: string): "landline" | "mobile" {
  return /^\+302\d{9}$/.test(number) ? "landline" : "mobile";
}

/** Not answered: the balance cannot pay a first minute. A rejected call is not billed by Twilio. */
const BUSY = '<Reject reason="busy"/>';

/** The last seconds of a call the balance cannot pay another minute of. */
const TIME_UP =
  '<Say language="el-GR">Ο διαθέσιμος χρόνος της γραμμής τελείωσε. Παρακαλούμε καλέστε ξανά αργότερα.</Say><Hangup/>';

/** What parts of a call cost: whole minutes, each at its rate. */
export function costOf(parts: CallPart[], rates: Rates): number {
  return parts.reduce(
    (sum, part) =>
      sum + Math.ceil(Math.max(0, part.seconds) / 60) * rates[part.kind],
    0,
  );
}

const CUSTOMER_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const STATES = new Set(["ok", "low", "empty"]);
const RETRY_MS = 60_000;
/** Alerts about one outage, or the next one, are at least this far apart. */
const ALERT_GAP_MS = 3600_000;
const GIVE_UP_MS = 24 * 3600_000;
/** No call is longer than this; a meter past it is let go (a lost end-of-call report). */
const MAX_CALL_MS = 4 * 3600_000;

/** Reads the lines file, again only when it changes. */
export function linesFromFile(path: string): () => Line[] {
  let seen = -1;
  let cached: Line[] = [];
  return () => {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return cached;
    }
    if (mtime === seen) return cached;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { lines?: unknown };
    const list = Array.isArray(raw.lines) ? raw.lines : [];
    cached = list.filter(
      (line): line is Line =>
        typeof line?.name === "string" &&
        typeof line?.number === "string" &&
        E164.test(line.number) &&
        typeof line?.tokenSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(line.tokenSha256) &&
        (line.fallback === undefined ||
          (typeof line.fallback === "string" && E164.test(line.fallback))) &&
        (line.customerId === undefined ||
          (typeof line.customerId === "string" &&
            CUSTOMER_ID.test(line.customerId))),
    );
    seen = mtime;
    return cached;
  };
}

export function createRelay(config: RelayConfig) {
  const log = config.log ?? ((line: string) => console.log(line));
  const send = config.fetch ?? fetch;
  /** The install connected for each line, by line name. The newest connection wins. */
  const desks = new Map<string, ServerWebSocket<SocketData>>();
  /** One-time keys a signed webhook handed out, until Twilio's media socket presents them. */
  const pending = new Map<
    string,
    { callId: string; line: Line; from: string; at: number }
  >();
  /** Live calls: Twilio's media socket and the line, by call id. */
  const calls = new Map<
    string,
    { twilio: ServerWebSocket<SocketData>; line: Line; startedAt: number }
  >();

  function lineFor(number: string): Line | undefined {
    return config.lines().find((line) => line.number === number);
  }

  // ---- the prepaid balance ---------------------------------------------------------------------

  type BilledLine = Line & { customerId: string };
  /** A billed call in progress: what it has set aside, minute by minute. */
  type Meter = {
    line: BilledLine;
    startedAt: number;
    /** Incoming minutes set aside so far. */
    minutes: number;
    reserved: number;
    /** Of `reserved`, the part for the forwarded leg. */
    reservedForward: number;
    forward?: "landline" | "mobile";
    timer?: ReturnType<typeof setTimeout>;
    ending: boolean;
  };

  const minuteMs = config.billing?.minuteMs ?? 60_000;
  const marginMs = config.billing?.marginMs ?? 12_000;
  /** The last balance blackark.uk gave, per customer. */
  const wallets = new Map<string, BalanceView>();
  const meters = new Map<string, Meter>();
  /** blackark.uk is not answering; the customers whose one call it allows was already answered. */
  let billingDown = false;
  let lastAlertAt = 0;
  const answeredWhileDown = new Set<string>();

  /** blackark.uk failed to answer: the first time in an outage, BlackArk is told, at most hourly. */
  function billingFailed() {
    if (billingDown) return;
    billingDown = true;
    log("billing: blackark.uk is not answering");
    if (Date.now() - lastAlertAt < ALERT_GAP_MS) return;
    lastAlertAt = Date.now();
    const subject = "ArkAgent phone relay: blackark.uk is not answering";
    const body = [
      `Since ${new Date().toISOString()} (UTC) the phone relay cannot reach ${config.billing?.url ?? "the balance page"}.`,
      "",
      "Until it answers again, on each billed line ONE call per customer is answered on the last balance the relay knew, and further calls hear busy. The cost of that one call beyond what is later booked is BlackArk's, never the customer's.",
      "",
      "Please check blackark.uk (the checkin/phone page and its config). No further alert is sent for this outage; the relay logs when it recovers.",
    ].join("\n");
    if (!config.alert) {
      log("billing: ALERT (no mailbox set up): blackark.uk is not answering");
      return;
    }
    void config.alert(subject, body).then(
      () => log("billing: alert sent to BlackArk"),
      (error) =>
        log(
          `billing: ALERT NOT SENT (${error instanceof Error ? error.message : String(error)})`,
        ),
    );
  }

  function billingAnswered() {
    if (!billingDown) return;
    billingDown = false;
    answeredWhileDown.clear();
    log("billing: blackark.uk answers again");
  }
  /** Charges blackark.uk could not take yet, retried every minute for a day. */
  const unsent: {
    line: BilledLine;
    callId: string;
    parts: CallPart[];
    firstAt: number;
    cost: number;
  }[] = [];

  function billed(line: Line | undefined): line is BilledLine {
    return Boolean(config.billing && line?.customerId);
  }

  /** The fallback dial, reporting its minutes back here when the line is billed. */
  function forward(line: Line | undefined): string {
    return handOver(
      line,
      billed(line) ? `${config.publicBaseUrl}/twilio/dialed` : undefined,
    );
  }

  async function billing(
    body: Record<string, unknown>,
  ): Promise<BalanceView | null> {
    if (!config.billing) return null;
    const text = JSON.stringify(body);
    const time = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", config.billing.secret)
      .update(`${time}.${text}`)
      .digest("hex");
    const response = await send(config.billing.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ark-time": String(time),
        "x-ark-signature": signature,
      },
      body: text,
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (!response?.ok) {
      billingFailed();
      return null;
    }
    const view = (await response
      .json()
      .catch(() => null)) as BalanceView | null;
    const rates = view?.rates;
    const valid = Boolean(
      view &&
        typeof view.balanceMils === "number" &&
        STATES.has(view.state) &&
        typeof view.topUpUrl === "string" &&
        rates &&
        [rates.incoming, rates.landline, rates.mobile].every(
          (rate) => Number.isInteger(rate) && rate > 0,
        ),
    );
    if (!valid) {
      billingFailed();
      return null;
    }
    billingAnswered();
    return view;
  }

  function tellDesk(line: Line, view: BalanceView) {
    toDesk(line, {
      type: "phone.balance",
      balanceMils: view.balanceMils,
      state: view.state,
      minutesLeftAtLeast: view.minutesLeftAtLeast,
      topUpUrl: view.topUpUrl,
    });
  }

  /** The balance less what live calls have set aside and what is not yet charged. */
  function available(customerId: string): number {
    const wallet = wallets.get(customerId);
    if (!wallet) return 0;
    let held = 0;
    for (const meter of meters.values())
      if (meter.line.customerId === customerId) held += meter.reserved;
    for (const entry of unsent)
      if (entry.line.customerId === customerId) held += entry.cost;
    return wallet.balanceMils - held;
  }

  function ratesFor(line: BilledLine): Rates {
    return (
      wallets.get(line.customerId)?.rates ?? {
        incoming: 78,
        landline: 88,
        mobile: 139,
      }
    );
  }

  async function balanceFor(line: Line): Promise<BalanceView | null> {
    if (!billed(line)) return null;
    const view = await billing({
      action: "balance",
      customerId: line.customerId,
    });
    if (view) wallets.set(line.customerId, view);
    else log(`line=${line.name}: balance unreachable`);
    return view;
  }

  /** The call's time is up: one sentence, then it ends, before a minute nobody can pay. */
  function cut(callId: string, meter: Meter, why: string) {
    meter.ending = true;
    clearTimeout(meter.timer);
    toDesk(meter.line, { type: "call.ending", callId });
    void redirect(callId, TIME_UP).then((ok) =>
      log(
        `call ${callId} line=${meter.line.name}: ${why}; ${ok ? "ended" : "END FAILED"}`,
      ),
    );
  }

  function schedule(callId: string, meter: Meter) {
    const due = meter.startedAt + meter.minutes * minuteMs - marginMs;
    meter.timer = setTimeout(
      () => nextMinute(callId),
      Math.max(0, due - Date.now()),
    );
    meter.timer.unref?.();
  }

  /** Shortly before a minute ends: set the next one aside, or end the call. */
  function nextMinute(callId: string) {
    const meter = meters.get(callId);
    if (!meter || meter.ending) return;
    if (Date.now() - meter.startedAt > MAX_CALL_MS) {
      // Twilio's end-of-call report never came (or the call really is this long): stop holding the
      // balance for it, and end it if it is still going.
      cut(callId, meter, "longer than the longest call");
      meters.delete(callId);
      return;
    }
    const rates = ratesFor(meter.line);
    const forwarded = meter.forward ? rates[meter.forward] : 0;
    const next = rates.incoming + forwarded;
    if (available(meter.line.customerId) < next) {
      cut(callId, meter, "balance used up");
      return;
    }
    meter.reserved += next;
    meter.reservedForward += forwarded;
    meter.minutes += 1;
    schedule(callId, meter);
  }

  /**
   * Before a billed call is answered: the TwiML that refuses it, or null when its first minute is set
   * aside (with the forwarded leg's, when it goes straight to the fallback).
   */
  async function admit(
    line: BilledLine,
    callId: string,
    forwarded: boolean,
  ): Promise<string | null> {
    const view = await balanceFor(line);
    if (!view) {
      // blackark.uk is not answering: one call per customer on the last balance known, then busy.
      if (
        !wallets.has(line.customerId) ||
        answeredWhileDown.has(line.customerId)
      ) {
        log(`call ${callId} line=${line.name}: balance unknown, busy`);
        return BUSY;
      }
      answeredWhileDown.add(line.customerId);
      log(
        `call ${callId} line=${line.name}: blackark.uk not answering; this one call on the last balance known`,
      );
    }
    const rates = ratesFor(line);
    const kind =
      forwarded && line.fallback ? forwardKind(line.fallback) : undefined;
    const first = rates.incoming + (kind ? rates[kind] : 0);
    if (available(line.customerId) < first) {
      log(`call ${callId} line=${line.name}: balance used up, busy`);
      return BUSY;
    }
    const meter: Meter = {
      line,
      startedAt: Date.now(),
      minutes: 1,
      reserved: first,
      reservedForward: kind ? rates[kind] : 0,
      forward: kind,
      ending: false,
    };
    meters.set(callId, meter);
    schedule(callId, meter);
    return null;
  }

  /** Puts a live call through to the line's fallback, first setting that leg's minute aside. */
  function transfer(callId: string, line: Line, why: string) {
    const meter = meters.get(callId);
    if (billed(line) && meter && !meter.forward && line.fallback) {
      if (meter.ending) return;
      const kind = forwardKind(line.fallback);
      const rate = ratesFor(line)[kind];
      if (available(line.customerId) < rate) {
        cut(callId, meter, "balance cannot pay a forwarded minute");
        return;
      }
      meter.reserved += rate;
      meter.reservedForward += rate;
      meter.forward = kind;
    }
    void redirect(callId, forward(line)).then((ok) =>
      log(
        `call ${callId} line=${line.name}: ${why}, hand-over ${ok ? "sent" : "failed"}`,
      ),
    );
  }

  /**
   * Reports a call's parts. `release` drops what the call set aside, once blackark.uk has the charge
   * or it is queued (when its cost is held until it is taken).
   */
  async function charge(
    line: Line,
    callId: string,
    parts: CallPart[],
    release: () => void = () => {},
  ) {
    if (!billed(line)) {
      release();
      return;
    }
    const view = await billing({
      action: "charge",
      customerId: line.customerId,
      callId,
      parts,
    });
    if (view) {
      wallets.set(line.customerId, view);
      release();
      tellDesk(line, view);
      log(
        `call ${callId} line=${line.name} charged ${parts.map((part) => `${part.kind} ${part.seconds}s`).join(", ")}`,
      );
      return;
    }
    unsent.push({
      line,
      callId,
      parts,
      firstAt: Date.now(),
      cost: costOf(parts, ratesFor(line)),
    });
    release();
    log(`call ${callId} line=${line.name}: charge not taken yet, will retry`);
  }

  /** One pass over the charges not yet taken. Runs every minute; tests call it directly. */
  async function retryCharges() {
    const now = Date.now();
    for (const entry of unsent.splice(0)) {
      if (now - entry.firstAt > GIVE_UP_MS) {
        log(
          `call ${entry.callId} line=${entry.line.name}: CHARGE DROPPED after a day: ${JSON.stringify(entry.parts)}`,
        );
        continue;
      }
      const view = await billing({
        action: "charge",
        customerId: entry.line.customerId,
        callId: entry.callId,
        parts: entry.parts,
      });
      if (view) {
        wallets.set(entry.line.customerId, view);
        tellDesk(entry.line, view);
      } else unsent.push(entry);
    }
  }
  if (config.billing)
    setInterval(() => void retryCharges(), RETRY_MS).unref?.();

  async function signedForm(
    request: Request,
    path: string,
  ): Promise<Record<string, string> | null> {
    const signature = request.headers.get("x-twilio-signature") ?? "";
    const text = await request.text();
    if (text.length > 16 * 1024) return null;
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) params[key] = value;
    const expected = twilioSignature(
      config.authToken,
      `${config.publicBaseUrl}${path}`,
      params,
    );
    if (!signature || !sameText(signature, expected)) return null;
    if (params.AccountSid !== config.accountSid) return null;
    return params;
  }

  /** Moves a live call to new TwiML through Twilio's API: hand-over or hang-up. */
  async function redirect(callId: string, body: string): Promise<boolean> {
    if (!CALL_SID.test(callId)) return false;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Calls/${callId}.json`;
    const response = await send(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
      }).toString(),
    }).catch(() => null);
    return Boolean(response?.ok);
  }

  function toDesk(line: Line, message: Record<string, unknown>): boolean {
    const desk = desks.get(line.name);
    if (!desk) return false;
    desk.send(JSON.stringify(message));
    return true;
  }

  function endCall(callId: string, reason: string) {
    const call = calls.get(callId);
    if (!call) return;
    calls.delete(callId);
    toDesk(call.line, { type: "call.end", callId });
    log(
      `call ${callId} line=${call.line.name} ended (${reason}) after ${Math.round((Date.now() - call.startedAt) / 1000)}s`,
    );
  }

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of pending)
      if (now - entry.at > PENDING_MS) pending.delete(key);
  }

  async function fetchHandler(
    request: Request,
    server: Server,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    sweep();

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/line") {
      const header = request.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const hash = token ? sha256Hex(token) : "";
      const line = config
        .lines()
        .find((entry) => hash && sameText(entry.tokenSha256, hash));
      if (!line)
        return new Response("This line token is not known here.", {
          status: 401,
        });
      if (
        server.upgrade(request, {
          data: { kind: "desk", line } satisfies SocketData,
        })
      )
        return undefined;
      return new Response("Expected a WebSocket.", { status: 426 });
    }

    if (url.pathname === "/twilio/media") {
      if (
        server.upgrade(request, {
          data: { kind: "twilio" } satisfies SocketData,
        })
      )
        return undefined;
      return new Response("Expected a WebSocket.", { status: 426 });
    }

    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });

    if (url.pathname === "/twilio/voice") {
      const form = await signedForm(request, "/twilio/voice");
      if (!form) return new Response("Forbidden", { status: 403 });
      const callId = form.CallSid ?? "";
      const line = lineFor(form.To ?? "");
      if (!line || !CALL_SID.test(callId)) return twiml(SORRY);
      if (billed(line)) {
        const refused = await admit(line, callId, !desks.has(line.name));
        if (refused) return twiml(refused);
      }
      if (!desks.has(line.name)) {
        log(
          `call ${callId} line=${line.name}: install not connected, handed over`,
        );
        return twiml(forward(line));
      }
      const key = randomBytes(24).toString("base64url");
      pending.set(key, { callId, line, from: form.From ?? "", at: Date.now() });
      const host = new URL(config.publicBaseUrl).host;
      return twiml(
        // A billed call is put through only by `transfer`, which first sets the leg's minute aside.
        `<Connect><Stream url="wss://${xml(host)}/twilio/media"><Parameter name="key" value="${xml(key)}"/></Stream></Connect>${billed(line) ? "<Hangup/>" : forward(line)}`,
      );
    }

    if (url.pathname === "/twilio/status") {
      const form = await signedForm(request, "/twilio/status");
      if (!form) return new Response("Forbidden", { status: 403 });
      const line = lineFor(form.To ?? "");
      if (line && CALL_SID.test(form.CallSid ?? "")) {
        toDesk(line, {
          type: "call.status",
          callId: form.CallSid,
          status: form.CallStatus ?? "",
          duration: Number(form.CallDuration ?? 0) || 0,
        });
        const callId = form.CallSid ?? "";
        const seconds = Math.trunc(Number(form.CallDuration ?? 0)) || 0;
        const status = form.CallStatus ?? "";
        const meter = meters.get(callId);
        const release = () => {
          clearTimeout(meter?.timer);
          meters.delete(callId);
        };
        if (status === "completed" && seconds > 0) {
          if (meter) {
            // Ended: no more minutes; what it set aside stays until the charge is taken.
            meter.ending = true;
            clearTimeout(meter.timer);
          }
          void charge(line, callId, [{ kind: "incoming", seconds }], release);
        } else if (
          ["completed", "busy", "failed", "no-answer", "canceled"].includes(
            status,
          )
        ) {
          release();
        }
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/twilio/dialed") {
      // Twilio reports here when a forwarded leg ends (only billed lines dial with this action).
      const form = await signedForm(request, "/twilio/dialed");
      if (!form) return new Response("Forbidden", { status: 403 });
      const line = lineFor(form.To ?? "");
      const seconds = Math.trunc(Number(form.DialCallDuration ?? 0)) || 0;
      const callId = form.CallSid ?? "";
      if (line?.fallback && CALL_SID.test(callId) && seconds > 0) {
        const meter = meters.get(callId);
        if (meter) meter.forward = undefined;
        void charge(
          line,
          callId,
          [{ kind: forwardKind(line.fallback), seconds }],
          () => {
            // The forwarded leg is charged: what was set aside for it is no longer held.
            if (!meter) return;
            meter.reserved -= meter.reservedForward;
            meter.reservedForward = 0;
          },
        );
      }
      return twiml("<Hangup/>");
    }

    return new Response("Not found", { status: 404 });
  }

  function onDeskMessage(
    desk: ServerWebSocket<SocketData> & { data: { kind: "desk"; line: Line } },
    raw: string,
  ) {
    let message: DeskMessage;
    try {
      message = JSON.parse(raw) as DeskMessage;
    } catch {
      return;
    }
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.callId !== "string"
    )
      return;
    const call = calls.get(message.callId);
    // An install may only act on calls on its own line.
    if (!call || call.line.name !== desk.data.line.name) return;
    const streamSid = (call.twilio.data as { streamSid?: string }).streamSid;
    switch (message.type) {
      case "media":
        if (
          typeof message.payload === "string" &&
          message.payload.length <= MAX_AUDIO_B64 &&
          streamSid
        ) {
          call.twilio.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: message.payload },
            }),
          );
        }
        return;
      case "clear":
        if (streamSid)
          call.twilio.send(JSON.stringify({ event: "clear", streamSid }));
        return;
      case "mark":
        if (
          streamSid &&
          typeof message.name === "string" &&
          message.name.length <= 64
        ) {
          call.twilio.send(
            JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: message.name },
            }),
          );
        }
        return;
      case "transfer":
        transfer(message.callId, call.line, "the install asked");
        return;
      case "hangup":
        void redirect(message.callId, "<Hangup/>");
        return;
    }
  }

  function onTwilioMessage(
    socket: ServerWebSocket<SocketData> & { data: { kind: "twilio" } },
    raw: string,
  ) {
    let event: {
      event?: string;
      start?: {
        callSid?: string;
        streamSid?: string;
        customParameters?: Record<string, string>;
      };
      streamSid?: string;
      media?: { payload?: string; track?: string };
      dtmf?: { digit?: string };
      mark?: { name?: string };
    };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const data = socket.data as {
      kind: "twilio";
      callId?: string;
      streamSid?: string;
      line?: Line;
    };
    switch (event.event) {
      case "connected":
        return;
      case "start": {
        const key = event.start?.customParameters?.key ?? "";
        const entry = pending.get(key);
        pending.delete(key);
        if (
          !entry ||
          entry.callId !== event.start?.callSid ||
          !event.start?.streamSid
        ) {
          socket.close(1008, "unknown call");
          return;
        }
        data.callId = entry.callId;
        data.streamSid = event.start.streamSid;
        data.line = entry.line;
        calls.set(entry.callId, {
          twilio: socket,
          line: entry.line,
          startedAt: Date.now(),
        });
        if (
          !toDesk(entry.line, {
            type: "call.start",
            callId: entry.callId,
            from: entry.from,
            to: entry.line.number,
          })
        ) {
          // The install went away between the webhook and the stream: hand the caller over.
          transfer(entry.callId, entry.line, "install gone before the stream");
          socket.close(1000, "no install");
          return;
        }
        log(`call ${entry.callId} line=${entry.line.name} started`);
        return;
      }
      case "media":
        if (
          data.callId &&
          data.line &&
          typeof event.media?.payload === "string" &&
          event.media.payload.length <= MAX_AUDIO_B64
        ) {
          toDesk(data.line, {
            type: "media",
            callId: data.callId,
            payload: event.media.payload,
          });
        }
        return;
      case "dtmf":
        if (
          data.callId &&
          data.line &&
          /^[0-9*#]$/.test(event.dtmf?.digit ?? "")
        ) {
          toDesk(data.line, {
            type: "dtmf",
            callId: data.callId,
            digit: event.dtmf?.digit,
          });
        }
        return;
      case "mark":
        if (data.callId && data.line)
          toDesk(data.line, {
            type: "mark",
            callId: data.callId,
            name: event.mark?.name ?? "",
          });
        return;
      case "stop":
        if (data.callId) endCall(data.callId, "caller or Twilio ended it");
        return;
    }
  }

  const websocket = {
    maxPayloadLength: MAX_FRAME,
    idleTimeout: 120,
    open(socket: ServerWebSocket<SocketData>) {
      if (socket.data.kind === "desk") {
        const line = socket.data.line;
        const older = desks.get(line.name);
        desks.set(line.name, socket);
        older?.close(4000, "replaced by a newer connection for this line");
        socket.send(
          JSON.stringify({
            type: "hello",
            line: line.name,
            number: line.number,
          }),
        );
        log(`line=${line.name}: install connected`);
        void balanceFor(line).then((view) => {
          if (view && desks.get(line.name) === socket) tellDesk(line, view);
        });
      }
    },
    message(socket: ServerWebSocket<SocketData>, raw: string | Buffer) {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      if (socket.data.kind === "desk") onDeskMessage(socket as never, text);
      else onTwilioMessage(socket as never, text);
    },
    close(socket: ServerWebSocket<SocketData>) {
      if (socket.data.kind === "desk") {
        const line = socket.data.line;
        if (desks.get(line.name) !== socket) return;
        desks.delete(line.name);
        log(`line=${line.name}: install disconnected`);
        // Calls the install was answering go to the fallback rather than to silence.
        for (const [callId, call] of calls) {
          if (call.line.name === line.name)
            transfer(callId, line, "install disconnected");
        }
        return;
      }
      const callId = (socket.data as { callId?: string }).callId;
      if (callId) endCall(callId, "stream closed");
    },
  };

  return {
    fetch: fetchHandler,
    websocket,
    retryCharges,
    state: { desks, pending, calls, unsent, meters, wallets },
  };
}

/** BlackArk's internal alert mailbox, from .env (written by `./deploy.sh alerts`), or none. */
function alertFromEnv():
  | ((subject: string, body: string) => Promise<void>)
  | undefined {
  const env = (name: string) => process.env[name]?.trim() ?? "";
  const to = env("ALERT_TO")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (!env("ALERT_SMTP_USER") || !env("ALERT_SMTP_PASSWORD") || to.length === 0)
    return undefined;
  const smtp: SmtpConfig = {
    host: env("ALERT_SMTP_HOST") || "send.one.com",
    port: Number(env("ALERT_SMTP_PORT") || 465),
    user: env("ALERT_SMTP_USER"),
    password: env("ALERT_SMTP_PASSWORD"),
    from: env("ALERT_FROM") || env("ALERT_SMTP_USER"),
    to,
  };
  return (subject, body) => sendMail(smtp, subject, body);
}

if (import.meta.main) {
  const need = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) {
      console.error(`${name} is not set. See README.md.`);
      process.exit(1);
    }
    return value;
  };
  const relay = createRelay({
    accountSid: need("TWILIO_ACCOUNT_SID"),
    authToken: need("TWILIO_AUTH_TOKEN"),
    publicBaseUrl: need("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    lines: linesFromFile(
      process.env.RELAY_LINES_FILE?.trim() || "/data/lines.json",
    ),
    billing:
      process.env.BILLING_URL?.trim() && process.env.BILLING_SECRET?.trim()
        ? {
            url: process.env.BILLING_URL.trim(),
            secret: process.env.BILLING_SECRET.trim(),
          }
        : undefined,
    alert: alertFromEnv(),
  });
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8080),
    fetch: relay.fetch,
    websocket: relay.websocket,
  });
  console.log(`phone relay listening on ${server.port}`);
}
