/**
 * What the two phone relays share (#109): the Bun one (`relay.ts`, Docker) and the Workers one
 * (`worker/`). Types, limits, the TwiML callers hear, the prepaid balance's rules and arithmetic, the
 * messages between the relay and the install, and the checks done with WebCrypto (which both Bun and
 * Workers have). Nothing here touches a socket, a timer or storage: those are each platform's own.
 *
 * Nothing here ever puts a caller's number in a log line.
 */

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

/** Desk → relay messages. Anything else is dropped. */
export type DeskMessage =
  | { type: "media"; callId: string; payload: string }
  | { type: "clear"; callId: string }
  | { type: "mark"; callId: string; name: string }
  | { type: "transfer"; callId: string }
  | { type: "hangup"; callId: string };

/** What Twilio's media socket sends (only the fields read). */
export type TwilioEvent = {
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

export const E164 = /^\+[1-9]\d{6,14}$/;
export const CALL_SID = /^CA[0-9a-f]{32}$/;
export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
export const LINE_NAME = /^[a-z0-9-]{2,40}$/;
export const CUSTOMER_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const MAX_FRAME = 64 * 1024;
export const MAX_AUDIO_B64 = 16 * 1024;
/** The one-time media key lives this long. */
export const PENDING_MS = 30_000;
const STATES = new Set(["ok", "low", "empty"]);
/** Unsent charges are tried again this often, for a day. */
export const RETRY_MS = 60_000;
/** Alerts about one outage, or the next one, are at least this far apart. */
export const ALERT_GAP_MS = 3600_000;
export const GIVE_UP_MS = 24 * 3600_000;
/** No call is longer than this; a meter past it is let go (a lost end-of-call report). */
export const MAX_CALL_MS = 4 * 3600_000;
/** A minute, and how long before its end the next one is set aside or the call ended. */
export const MINUTE_MS = 60_000;
export const MARGIN_MS = 12_000;
/** How often a low or used-up balance is asked again for a connected install (v0.1.49). */
export const REFRESH_MS = 5 * 60_000;
/** The rates until blackark.uk has said its own. */
export const DEFAULT_RATES: Rates = { incoming: 78, landline: 88, mobile: 139 };

// ---- TwiML ---------------------------------------------------------------------------------------

export function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twimlText(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export function twiml(body: string): Response {
  return new Response(twimlText(body), {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

/** Greek first: the callers are in Greece. */
export const SORRY =
  '<Say language="el-GR">Λυπούμαστε, η γραμμή δεν είναι διαθέσιμη αυτή τη στιγμή. Παρακαλούμε καλέστε ξανά αργότερα.</Say><Hangup/>';

/** Not answered: the balance cannot pay a first minute. A rejected call is not billed by Twilio. */
export const BUSY = '<Reject reason="busy"/>';

/** The last seconds of a call the balance cannot pay another minute of. */
export const TIME_UP =
  '<Say language="el-GR">Ο διαθέσιμος χρόνος της γραμμής τελείωσε. Παρακαλούμε καλέστε ξανά αργότερα.</Say><Hangup/>';

/** Dials the line's fallback. `action`, when billed, is where Twilio reports the forwarded minutes. */
export function handOver(line: Line | undefined, action?: string): string {
  if (!line?.fallback || !E164.test(line.fallback)) return SORRY;
  return action
    ? `<Dial action="${xml(action)}">${xml(line.fallback)}</Dial>`
    : `<Dial>${xml(line.fallback)}</Dial>`;
}

/** Greek landlines start +302; anything else is charged at the mobile rate, the higher one. */
export function forwardKind(number: string): "landline" | "mobile" {
  return /^\+302\d{9}$/.test(number) ? "landline" : "mobile";
}

/** What parts of a call cost: whole minutes, each at its rate. */
export function costOf(parts: CallPart[], rates: Rates): number {
  return parts.reduce(
    (sum, part) =>
      sum + Math.ceil(Math.max(0, part.seconds) / 60) * rates[part.kind],
    0,
  );
}

/** A Twilio form's numbers, as a whole number of seconds. */
export function seconds(value: string | undefined): number {
  return Math.trunc(Number(value ?? 0)) || 0;
}

/** Statuses that end a call, after which nothing more is set aside for it. */
export const ENDED = ["completed", "busy", "failed", "no-answer", "canceled"];

// ---- the prepaid balance -------------------------------------------------------------------------

/** blackark.uk's answer, or null when anything is missing (then it counts as not answering). */
export function parseBalanceView(value: unknown): BalanceView | null {
  const view = value as BalanceView | null;
  const rates = view?.rates;
  const valid = Boolean(
    view &&
      typeof view === "object" &&
      typeof view.balanceMils === "number" &&
      STATES.has(view.state) &&
      typeof view.topUpUrl === "string" &&
      rates &&
      [rates.incoming, rates.landline, rates.mobile].every(
        (rate) => Number.isInteger(rate) && rate > 0,
      ),
  );
  return valid ? view : null;
}

/** What the install is told of the balance (the app shows it under Settings → Phone line). */
export function balanceMessage(view: BalanceView) {
  return {
    type: "phone.balance",
    balanceMils: view.balanceMils,
    state: view.state,
    minutesLeftAtLeast: view.minutesLeftAtLeast,
    topUpUrl: view.topUpUrl,
  };
}

/** BlackArk's internal alert when blackark.uk stops answering. Nothing about a customer or caller. */
export function outageAlert(billingUrl: string | undefined, now: Date) {
  return {
    subject: "ArkAgent phone relay: blackark.uk is not answering",
    body: [
      `Since ${now.toISOString()} (UTC) the phone relay cannot reach ${billingUrl ?? "the balance page"}.`,
      "",
      "Until it answers again, on each billed line ONE call per customer is answered on the last balance the relay knew, and further calls hear busy. The cost of that one call beyond what is later booked is BlackArk's, never the customer's.",
      "",
      "Please check blackark.uk (the checkin/phone page and its config). No further alert is sent for this outage; the relay logs when it recovers.",
    ].join("\n"),
  };
}

// ---- messages between the relay, Twilio and the install ------------------------------------------

export function parseDeskMessage(raw: string): DeskMessage | null {
  let message: DeskMessage;
  try {
    message = JSON.parse(raw) as DeskMessage;
  } catch {
    return null;
  }
  if (
    !message ||
    typeof message !== "object" ||
    typeof message.callId !== "string"
  )
    return null;
  return message;
}

/** The frame for Twilio's media socket a desk message turns into, or null (none, or not allowed). */
export function deskToTwilio(
  message: DeskMessage,
  streamSid: string | undefined,
): string | null {
  if (!streamSid) return null;
  switch (message.type) {
    case "media":
      return typeof message.payload === "string" &&
        message.payload.length <= MAX_AUDIO_B64
        ? JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: message.payload },
          })
        : null;
    case "clear":
      return JSON.stringify({ event: "clear", streamSid });
    case "mark":
      return typeof message.name === "string" && message.name.length <= 64
        ? JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: message.name },
          })
        : null;
    default:
      return null;
  }
}

export function parseTwilioEvent(raw: string): TwilioEvent | null {
  try {
    const event = JSON.parse(raw) as TwilioEvent;
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

/** The desk message a Twilio media, dtmf or mark event turns into, or null. */
export function twilioToDesk(
  event: TwilioEvent,
  callId: string,
): Record<string, unknown> | null {
  switch (event.event) {
    case "media":
      return typeof event.media?.payload === "string" &&
        event.media.payload.length <= MAX_AUDIO_B64
        ? { type: "media", callId, payload: event.media.payload }
        : null;
    case "dtmf":
      return /^[0-9*#]$/.test(event.dtmf?.digit ?? "")
        ? { type: "dtmf", callId, digit: event.dtmf?.digit }
        : null;
    case "mark":
      return { type: "mark", callId, name: event.mark?.name ?? "" };
    default:
      return null;
  }
}

// ---- checks and signatures, by WebCrypto ---------------------------------------------------------

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** What Twilio signs: the URL, then each form field sorted, as key+value. */
export function signatureBase(
  url: string,
  params: Record<string, string>,
): string {
  return (
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("")
  );
}

async function hmac(
  algorithm: "SHA-1" | "SHA-256",
  secret: string,
  data: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

export async function hmacSha1Base64(
  secret: string,
  data: string,
): Promise<string> {
  return bytesToBase64(new Uint8Array(await hmac("SHA-1", secret, data)));
}

export async function sha256HexWeb(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Compares in time that depends only on the length. */
export function sameText(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** The headers blackark.uk's phone page checks: the time, and HMAC-SHA256 of "time.body". */
export async function billingHeaders(
  secret: string,
  body: string,
  time = Math.floor(Date.now() / 1000),
): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-ark-time": String(time),
    "x-ark-signature": hex(await hmac("SHA-256", secret, `${time}.${body}`)),
  };
}

export function twilioBasicAuth(accountSid: string, authToken: string) {
  return `Basic ${bytesToBase64(encoder.encode(`${accountSid}:${authToken}`))}`;
}

/** Twilio's REST call that moves a live call to new TwiML: a hand-over or a hang-up. */
export function redirectRequest(
  accountSid: string,
  authToken: string,
  callId: string,
  body: string,
): { url: string; init: RequestInit } | null {
  if (!CALL_SID.test(callId)) return null;
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${callId}.json`,
    init: {
      method: "POST",
      headers: {
        authorization: twilioBasicAuth(accountSid, authToken),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Twiml: twimlText(body) }).toString(),
    },
  };
}

/** A random key, URL-safe, `bytes` long before encoding. */
export function randomKey(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64(raw)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
