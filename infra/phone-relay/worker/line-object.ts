/**
 * One phone line on the Workers relay: a Durable Object per line, named by the line's name. It holds
 * the install's `/line` socket and each live call's Twilio media socket (Hibernation API: the runtime
 * keeps them open while the object sleeps), and the line's prepaid balance in SQLite: what each live
 * call has set aside (its meter), charges blackark.uk has not taken yet, and the last balance known.
 *
 * TIME. One alarm per object, set to the earliest of: a live call's next minute (12 s before the one
 * it is in ends: the next is set aside, or the call hears the Greek sentence and ends), the retry of
 * unsent charges (every minute, for a day), and, while the install is connected and the balance is
 * low, used up or unknown, the re-ask of blackark.uk (every 5 minutes, v0.1.49).
 *
 * The rules are the Bun relay's (`../relay.ts`), from `../core.ts`. This object keeps no caller
 * number: it reaches the install as the media stream's own parameter, and no log line carries it.
 */
import {
  type BalanceView,
  BUSY,
  balanceMessage,
  billingHeaders,
  CALL_SID,
  type CallPart,
  costOf,
  DEFAULT_RATES,
  deskToTwilio,
  E164,
  ENDED,
  forwardKind,
  GIVE_UP_MS,
  handOver,
  type Line,
  MARGIN_MS,
  MAX_CALL_MS,
  MINUTE_MS,
  PENDING_MS,
  parseBalanceView,
  parseDeskMessage,
  parseTwilioEvent,
  type Rates,
  REFRESH_MS,
  RETRY_MS,
  randomKey,
  redirectRequest,
  SORRY,
  seconds,
  sha256HexWeb,
  TIME_UP,
  twilioToDesk,
  twiml,
  xml,
} from "../core";
import { call } from "./directory-object";
import type {
  CfWebSocket,
  DurableObjectState,
  Env,
  Platform,
  SqlStorage,
} from "./types";

/** The header the Worker names the line in; set only by this Worker's own code. */
export const LINE_HEADER = "x-phone-line";
/** An install may send this to keep its socket warm; the runtime answers without waking the object. */
export const PING = '{"type":"ping"}';
export const PONG = '{"type":"pong"}';

type DeskAttachment = { kind: "desk" };
type TwilioAttachment = {
  kind: "twilio";
  callId?: string;
  streamSid?: string;
  startedAt?: number;
  ended?: boolean;
};

type MeterRow = {
  call: string;
  started: number;
  minutes: number;
  reserved: number;
  reserved_forward: number;
  forward: "landline" | "mobile" | null;
  ending: number;
};

export class LineObject {
  private sql: SqlStorage;
  private minuteMs: number;
  private marginMs: number;
  private refreshMs: number;
  private retryMs: number;
  /** Live calls' media sockets by call id; rebuilt from attachments after hibernation. */
  private calls = new Map<string, CfWebSocket>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
    private platform: Platform,
  ) {
    this.sql = state.storage.sql;
    this.minuteMs = platform.timing?.minuteMs ?? MINUTE_MS;
    this.marginMs = platform.timing?.marginMs ?? MARGIN_MS;
    this.refreshMs = platform.timing?.refreshMs ?? REFRESH_MS;
    this.retryMs = platform.timing?.retryMs ?? RETRY_MS;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meters (call TEXT PRIMARY KEY, started INTEGER NOT NULL, minutes INTEGER NOT NULL, reserved INTEGER NOT NULL, reserved_forward INTEGER NOT NULL, forward TEXT, ending INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS unsent (id INTEGER PRIMARY KEY AUTOINCREMENT, call TEXT NOT NULL, parts TEXT NOT NULL, first_at INTEGER NOT NULL, cost INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY, call TEXT NOT NULL, at INTEGER NOT NULL)",
    );
    state.setWebSocketAutoResponse(platform.autoResponse(PING, PONG));
  }

  // ---- storage ---------------------------------------------------------------------------------

  private meta(key: string): string | undefined {
    return this.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key)
      .toArray()[0]?.v;
  }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE k = ?", key);
    else
      this.sql.exec(
        "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
        key,
        value,
      );
  }

  private line(): Line | null {
    const text = this.meta("line");
    return text ? (JSON.parse(text) as Line) : null;
  }
  private wallet(): BalanceView | null {
    const text = this.meta("wallet");
    return text ? (JSON.parse(text) as BalanceView) : null;
  }
  private meter(callId: string): MeterRow | undefined {
    return this.sql
      .exec<MeterRow>("SELECT * FROM meters WHERE call = ?", callId)
      .toArray()[0];
  }

  private billing() {
    const url = this.env.BILLING_URL?.trim();
    const secret = this.env.RELAY_SECRET?.trim();
    return url && secret ? { url, secret } : null;
  }

  /** The line's customer, when it is billed (and billing is set up). */
  private customer(): string | null {
    return this.billing() ? (this.line()?.customerId ?? null) : null;
  }

  private rates(): Rates {
    return this.wallet()?.rates ?? DEFAULT_RATES;
  }

  /** The balance less what live calls have set aside and what is not yet charged. */
  private available(): number {
    const wallet = this.wallet();
    if (!wallet) return 0;
    const [held] = this.sql
      .exec<{ total: number }>(
        "SELECT (SELECT COALESCE(SUM(reserved), 0) FROM meters) + (SELECT COALESCE(SUM(cost), 0) FROM unsent) AS total",
      )
      .toArray();
    return wallet.balanceMils - (held?.total ?? 0);
  }

  // ---- sockets ---------------------------------------------------------------------------------

  private desk(): CfWebSocket | undefined {
    return this.state
      .getWebSockets("desk")
      .find(
        (socket) => socket.readyState === undefined || socket.readyState === 1,
      );
  }

  private toDesk(message: Record<string, unknown>): boolean {
    const desk = this.desk();
    if (!desk) return false;
    desk.send(JSON.stringify(message));
    return true;
  }

  private tellDesk(view: BalanceView) {
    this.toDesk(balanceMessage(view));
  }

  private twilioSocket(callId: string): CfWebSocket | undefined {
    const known = this.calls.get(callId);
    if (known) return known;
    for (const socket of this.state.getWebSockets("twilio")) {
      const attachment = socket.deserializeAttachment() as TwilioAttachment;
      if (attachment?.callId) this.calls.set(attachment.callId, socket);
    }
    return this.calls.get(callId);
  }

  private log(text: string) {
    this.platform.log(text);
  }

  // ---- outside services ------------------------------------------------------------------------

  private directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory"));
  }

  /** Moves a live call to new TwiML through Twilio's API: hand-over or hang-up. */
  private async redirect(callId: string, body: string): Promise<boolean> {
    const request = redirectRequest(
      this.env.TWILIO_ACCOUNT_SID,
      this.env.TWILIO_AUTH_TOKEN,
      callId,
      body,
    );
    if (!request) return false;
    const response = await this.platform
      .fetch(request.url, request.init)
      .catch(() => null);
    return Boolean(response?.ok);
  }

  private async ask(
    body: Record<string, unknown>,
  ): Promise<BalanceView | null> {
    const billing = this.billing();
    if (!billing) return null;
    const text = JSON.stringify(body);
    const response = await this.platform
      .fetch(billing.url, {
        method: "POST",
        headers: await billingHeaders(billing.secret, text),
        body: text,
        signal: AbortSignal.timeout(3000),
      })
      .catch(() => null);
    const view = response?.ok
      ? parseBalanceView(await response.json().catch(() => null))
      : null;
    if (!view) {
      await this.billingFailed();
      return null;
    }
    await this.billingAnswered();
    this.setMeta("wallet", JSON.stringify(view));
    return view;
  }

  /** The relay's outage state is the directory's, so BlackArk is alerted once for all lines. */
  private async billingFailed() {
    if (this.meta("down")) return;
    this.setMeta("down", "1");
    await call(this.directory(), "/billing-failed").catch(() => undefined);
  }

  private async billingAnswered() {
    if (!this.meta("down")) return;
    this.setMeta("down", null);
    this.setMeta("oneCallUsed", null);
    await call(this.directory(), "/billing-answered").catch(() => undefined);
  }

  private async balance(): Promise<BalanceView | null> {
    const customerId = this.customer();
    if (!customerId) return null;
    const view = await this.ask({ action: "balance", customerId });
    if (!view) this.log(`line=${this.line()?.name}: balance unreachable`);
    return view;
  }

  // ---- the prepaid balance ---------------------------------------------------------------------

  private forwardTwiml(): string {
    const line = this.line() ?? undefined;
    return handOver(
      line,
      this.customer()
        ? `${this.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/twilio/dialed`
        : undefined,
    );
  }

  /** The call's time is up: one sentence, then it ends, before a minute nobody can pay. */
  private async cut(callId: string, why: string) {
    this.sql.exec("UPDATE meters SET ending = 1 WHERE call = ?", callId);
    this.toDesk({ type: "call.ending", callId });
    const ok = await this.redirect(callId, TIME_UP);
    this.log(
      `call ${callId} line=${this.line()?.name}: ${why}; ${ok ? "ended" : "END FAILED"}`,
    );
  }

  /** Shortly before a minute ends: set the next one aside, or end the call. */
  private async nextMinute(meter: MeterRow) {
    if (Date.now() - meter.started > MAX_CALL_MS) {
      // Twilio's end-of-call report never came (or the call really is this long).
      await this.cut(meter.call, "longer than the longest call");
      this.sql.exec("DELETE FROM meters WHERE call = ?", meter.call);
      return;
    }
    const rates = this.rates();
    const forwarded = meter.forward ? rates[meter.forward] : 0;
    const next = rates.incoming + forwarded;
    if (this.available() < next) {
      await this.cut(meter.call, "balance used up");
      return;
    }
    this.sql.exec(
      "UPDATE meters SET reserved = reserved + ?, reserved_forward = reserved_forward + ?, minutes = minutes + 1 WHERE call = ?",
      next,
      forwarded,
      meter.call,
    );
  }

  /** Before a billed call is answered: the TwiML that refuses it, or null once its first minute is set aside. */
  private async admit(
    callId: string,
    forwarded: boolean,
  ): Promise<string | null> {
    const line = this.line() as Line;
    const view = await this.balance();
    // The install hears what blackark.uk said, so a top-up shows in the app with the next call.
    if (view) this.tellDesk(view);
    if (!view) {
      // blackark.uk is not answering: one call on the last balance known, then busy.
      if (!this.wallet() || this.meta("oneCallUsed")) {
        this.log(`call ${callId} line=${line.name}: balance unknown, busy`);
        return BUSY;
      }
      this.setMeta("oneCallUsed", "1");
      this.log(
        `call ${callId} line=${line.name}: blackark.uk not answering; this one call on the last balance known`,
      );
    }
    const rates = this.rates();
    const kind = forwarded && line.fallback ? forwardKind(line.fallback) : null;
    const forwardRate = kind ? rates[kind] : 0;
    const first = rates.incoming + forwardRate;
    if (this.available() < first) {
      this.log(`call ${callId} line=${line.name}: balance used up, busy`);
      return BUSY;
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO meters (call, started, minutes, reserved, reserved_forward, forward, ending) VALUES (?, ?, 1, ?, ?, ?, 0)",
      callId,
      Date.now(),
      first,
      forwardRate,
      kind,
    );
    return null;
  }

  /** Puts a live call through to the line's fallback, first setting that leg's minute aside. */
  private async transfer(callId: string, why: string) {
    const line = this.line();
    if (!line) return;
    const meter = this.meter(callId);
    if (this.customer() && meter && !meter.forward && line.fallback) {
      if (meter.ending) return;
      const kind = forwardKind(line.fallback);
      const rate = this.rates()[kind];
      if (this.available() < rate) {
        await this.cut(callId, "balance cannot pay a forwarded minute");
        return;
      }
      this.sql.exec(
        "UPDATE meters SET reserved = reserved + ?, reserved_forward = reserved_forward + ?, forward = ? WHERE call = ?",
        rate,
        rate,
        kind,
        callId,
      );
    }
    const ok = await this.redirect(callId, this.forwardTwiml());
    this.log(
      `call ${callId} line=${line.name}: ${why}, hand-over ${ok ? "sent" : "failed"}`,
    );
  }

  /** Reports a call's parts; `release` lets go of what it set aside once charged or queued. */
  private async charge(callId: string, parts: CallPart[], release: () => void) {
    const customerId = this.customer();
    if (!customerId) {
      release();
      return;
    }
    const view = await this.ask({
      action: "charge",
      customerId,
      callId,
      parts,
    });
    const name = this.line()?.name;
    if (view) {
      release();
      this.tellDesk(view);
      this.log(
        `call ${callId} line=${name} charged ${parts.map((part) => `${part.kind} ${part.seconds}s`).join(", ")}`,
      );
      return;
    }
    this.sql.exec(
      "INSERT INTO unsent (call, parts, first_at, cost) VALUES (?, ?, ?, ?)",
      callId,
      JSON.stringify(parts),
      Date.now(),
      costOf(parts, this.rates()),
    );
    if (!this.meta("retryAt"))
      this.setMeta("retryAt", String(Date.now() + this.retryMs));
    release();
    this.log(`call ${callId} line=${name}: charge not taken yet, will retry`);
  }

  /** One pass over unsent charges; at most 40, as Workers allows 50 outside calls per invocation. */
  private async retryCharges() {
    const customerId = this.customer();
    const rows = this.sql
      .exec<{ id: number; call: string; parts: string; first_at: number }>(
        "SELECT id, call, parts, first_at FROM unsent ORDER BY id LIMIT 40",
      )
      .toArray();
    for (const row of rows) {
      if (Date.now() - row.first_at > GIVE_UP_MS || !customerId) {
        this.log(
          `call ${row.call} line=${this.line()?.name}: CHARGE DROPPED: ${row.parts}`,
        );
        this.sql.exec("DELETE FROM unsent WHERE id = ?", row.id);
        continue;
      }
      const view = await this.ask({
        action: "charge",
        customerId,
        callId: row.call,
        parts: JSON.parse(row.parts),
      });
      if (!view) return;
      this.sql.exec("DELETE FROM unsent WHERE id = ?", row.id);
      this.tellDesk(view);
    }
  }

  /** Whether the install should hear about a top-up without a call: connected, billed, not "ok". */
  private needsRefresh(): boolean {
    return Boolean(
      this.desk() && this.customer() && this.wallet()?.state !== "ok",
    );
  }

  /** Sets the one alarm to the earliest thing due, or clears it. */
  private async reschedule() {
    const times: number[] = [];
    for (const meter of this.sql
      .exec<MeterRow>("SELECT * FROM meters")
      .toArray()) {
      times.push(
        meter.ending
          ? meter.started + MAX_CALL_MS
          : meter.started + meter.minutes * this.minuteMs - this.marginMs,
      );
    }
    const [unsent] = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM unsent")
      .toArray();
    if (unsent?.n) {
      const retryAt = Number(this.meta("retryAt") ?? Date.now() + this.retryMs);
      this.setMeta("retryAt", String(retryAt));
      times.push(retryAt);
    } else this.setMeta("retryAt", null);
    if (this.needsRefresh()) {
      const refreshAt = Number(
        this.meta("refreshAt") ?? Date.now() + this.refreshMs,
      );
      this.setMeta("refreshAt", String(refreshAt));
      times.push(refreshAt);
    } else this.setMeta("refreshAt", null);
    if (times.length === 0) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    const now = Date.now();
    for (const meter of this.sql
      .exec<MeterRow>("SELECT * FROM meters")
      .toArray()) {
      if (meter.ending) {
        if (now - meter.started > MAX_CALL_MS)
          this.sql.exec("DELETE FROM meters WHERE call = ?", meter.call);
        continue;
      }
      const due = meter.started + meter.minutes * this.minuteMs - this.marginMs;
      if (due <= now) await this.nextMinute(meter);
    }
    if (Number(this.meta("retryAt") ?? Infinity) <= now) {
      this.setMeta("retryAt", String(now + this.retryMs));
      await this.retryCharges();
    }
    if (Number(this.meta("refreshAt") ?? Infinity) <= now) {
      this.setMeta("refreshAt", null);
      if (this.needsRefresh()) {
        const view = await this.balance();
        if (view) this.tellDesk(view);
      }
    }
    await this.reschedule();
  }

  // ---- requests from the Worker ----------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const header = request.headers.get(LINE_HEADER);
    if (header) this.setMeta("line", header);
    const line = this.line();
    switch (path) {
      case "/desk":
        return this.acceptDesk();
      case "/media": {
        const { client, server } = this.platform.socketPair();
        this.state.acceptWebSocket(server, ["twilio"]);
        server.serializeAttachment({
          kind: "twilio",
        } satisfies TwilioAttachment);
        return this.platform.upgraded(client);
      }
      case "/forget":
        for (const desk of this.state.getWebSockets("desk"))
          desk.close(1008, "This line was removed.");
        this.setMeta("line", null);
        await this.reschedule();
        return Response.json({ ok: true });
      case "/update":
        await this.reschedule();
        return Response.json({ ok: true });
    }
    if (!line) return new Response("Not found.", { status: 404 });
    const form = (await request.json()) as Record<string, string>;
    let answer: Response;
    if (path === "/voice") answer = await this.voice(form, line);
    else if (path === "/status") answer = await this.status(form);
    else if (path === "/dialed") answer = await this.dialed(form, line);
    else answer = new Response("Not found.", { status: 404 });
    await this.reschedule();
    return answer;
  }

  private acceptDesk(): Response {
    const line = this.line() as Line;
    const { client, server } = this.platform.socketPair();
    for (const older of this.state.getWebSockets("desk"))
      older.close(4000, "replaced by a newer connection for this line");
    this.state.acceptWebSocket(server, ["desk"]);
    server.serializeAttachment({ kind: "desk" } satisfies DeskAttachment);
    server.send(
      JSON.stringify({ type: "hello", line: line.name, number: line.number }),
    );
    this.log(`line=${line.name}: install connected`);
    void (async () => {
      const view = await this.balance();
      if (view && this.desk() === server) this.tellDesk(view);
      await this.reschedule();
    })();
    return this.platform.upgraded(client);
  }

  private async voice(form: Record<string, string>, line: Line) {
    const callId = form.CallSid ?? "";
    if (!CALL_SID.test(callId)) return twiml(SORRY);
    const now = Date.now();
    this.sql.exec("DELETE FROM pending WHERE at < ?", now - PENDING_MS);
    const connected = Boolean(this.desk());
    if (this.customer()) {
      const refused = await this.admit(callId, !connected);
      if (refused) return twiml(refused);
    }
    if (!connected) {
      this.log(
        `call ${callId} line=${line.name}: install not connected, handed over`,
      );
      return twiml(this.forwardTwiml());
    }
    const key = randomKey();
    this.sql.exec(
      "INSERT INTO pending (key, call, at) VALUES (?, ?, ?)",
      await sha256HexWeb(key),
      callId,
      now,
    );
    const host = new URL(this.env.PUBLIC_BASE_URL).host;
    const from = E164.test(form.From ?? "") ? (form.From as string) : "";
    return twiml(
      // A billed call is put through only by `transfer`, which first sets the leg's minute aside.
      `<Connect><Stream url="wss://${xml(host)}/twilio/media/${xml(line.name)}"><Parameter name="key" value="${xml(key)}"/><Parameter name="from" value="${xml(from)}"/></Stream></Connect>${this.customer() ? "<Hangup/>" : this.forwardTwiml()}`,
    );
  }

  private async status(form: Record<string, string>) {
    const callId = form.CallSid ?? "";
    if (!CALL_SID.test(callId)) return new Response(null, { status: 204 });
    const status = form.CallStatus ?? "";
    const duration = seconds(form.CallDuration);
    this.toDesk({ type: "call.status", callId, status, duration });
    const release = () =>
      this.sql.exec("DELETE FROM meters WHERE call = ?", callId);
    if (status === "completed" && duration > 0) {
      // Ended: no more minutes; what it set aside stays until the charge is taken or queued.
      this.sql.exec("UPDATE meters SET ending = 1 WHERE call = ?", callId);
      await this.charge(
        callId,
        [{ kind: "incoming", seconds: duration }],
        release,
      );
    } else if (ENDED.includes(status)) release();
    return new Response(null, { status: 204 });
  }

  private async dialed(form: Record<string, string>, line: Line) {
    // Twilio reports here when a forwarded leg ends (only billed lines dial with this action).
    const callId = form.CallSid ?? "";
    const duration = seconds(form.DialCallDuration);
    if (line.fallback && CALL_SID.test(callId) && duration > 0) {
      this.sql.exec("UPDATE meters SET forward = NULL WHERE call = ?", callId);
      await this.charge(
        callId,
        [{ kind: forwardKind(line.fallback), seconds: duration }],
        () =>
          // The forwarded leg is charged: what was set aside for it is no longer held.
          this.sql.exec(
            "UPDATE meters SET reserved = reserved - reserved_forward, reserved_forward = 0 WHERE call = ?",
            callId,
          ),
      );
    }
    return twiml("<Hangup/>");
  }

  // ---- the Hibernation API's handlers ----------------------------------------------------------

  async webSocketMessage(socket: CfWebSocket, raw: string | ArrayBuffer) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const attachment = socket.deserializeAttachment() as
      | DeskAttachment
      | TwilioAttachment;
    if (attachment?.kind === "desk") await this.onDeskMessage(text);
    else await this.onTwilioMessage(socket, text);
  }

  private async onDeskMessage(raw: string) {
    const message = parseDeskMessage(raw);
    if (!message) return;
    // Only this line's calls are in this object: an install can act on no other.
    const twilio = this.twilioSocket(message.callId);
    if (!twilio) return;
    if (message.type === "transfer") {
      await this.transfer(message.callId, "the install asked");
      await this.reschedule();
      return;
    }
    if (message.type === "hangup") {
      await this.redirect(message.callId, "<Hangup/>");
      return;
    }
    const attachment = twilio.deserializeAttachment() as TwilioAttachment;
    const frame = deskToTwilio(message, attachment.streamSid);
    if (frame) twilio.send(frame);
  }

  private async onTwilioMessage(socket: CfWebSocket, raw: string) {
    const event = parseTwilioEvent(raw);
    if (!event) return;
    const attachment = socket.deserializeAttachment() as TwilioAttachment;
    if (event.event === "start") {
      const key = event.start?.customParameters?.key ?? "";
      const hash = key ? await sha256HexWeb(key) : "";
      const [entry] = this.sql
        .exec<{ call: string; at: number }>(
          "SELECT call, at FROM pending WHERE key = ?",
          hash,
        )
        .toArray();
      this.sql.exec("DELETE FROM pending WHERE key = ?", hash);
      const line = this.line();
      if (
        !entry ||
        !line ||
        Date.now() - entry.at > PENDING_MS ||
        entry.call !== event.start?.callSid ||
        !event.start?.streamSid
      ) {
        socket.close(1008, "unknown call");
        return;
      }
      socket.serializeAttachment({
        kind: "twilio",
        callId: entry.call,
        streamSid: event.start.streamSid,
        startedAt: Date.now(),
      } satisfies TwilioAttachment);
      this.calls.set(entry.call, socket);
      const from = event.start.customParameters?.from ?? "";
      if (
        !this.toDesk({
          type: "call.start",
          callId: entry.call,
          from: E164.test(from) ? from : "",
          to: line.number,
        })
      ) {
        // The install went away between the webhook and the stream: hand the caller over.
        await this.transfer(entry.call, "install gone before the stream");
        socket.close(1000, "no install");
        await this.reschedule();
        return;
      }
      this.log(`call ${entry.call} line=${line.name} started`);
      return;
    }
    if (!attachment?.callId) return;
    if (event.event === "stop") {
      this.endCall(socket, "caller or Twilio ended it");
      return;
    }
    const message = twilioToDesk(event, attachment.callId);
    if (message) this.toDesk(message);
  }

  /** Tells the install once that a call's stream ended (the mark survives hibernation). */
  private endCall(socket: CfWebSocket, reason: string) {
    const attachment = socket.deserializeAttachment() as TwilioAttachment;
    if (!attachment?.callId || attachment.ended) return;
    socket.serializeAttachment({ ...attachment, ended: true });
    this.calls.delete(attachment.callId);
    this.toDesk({ type: "call.end", callId: attachment.callId });
    this.log(
      `call ${attachment.callId} line=${this.line()?.name} ended (${reason}) after ${Math.round((Date.now() - (attachment.startedAt ?? Date.now())) / 1000)}s`,
    );
  }

  async webSocketClose(socket: CfWebSocket, code = 1000) {
    // Completes the close the other end began, as Cloudflare's Hibernation examples do.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {}
    const attachment = socket.deserializeAttachment() as
      | DeskAttachment
      | TwilioAttachment;
    if (attachment?.kind === "desk") {
      // Only the current install's going matters; a replaced one is already gone.
      if (this.state.getWebSockets("desk").some((desk) => desk !== socket))
        return;
      this.log(`line=${this.line()?.name}: install disconnected`);
      // Calls the install was answering go to the fallback rather than to silence.
      for (const twilio of this.state.getWebSockets("twilio")) {
        const call = twilio.deserializeAttachment() as TwilioAttachment;
        if (call?.callId && twilio !== socket)
          await this.transfer(call.callId, "install disconnected");
      }
      await this.reschedule();
      return;
    }
    this.endCall(socket, "stream closed");
  }

  async webSocketError(socket: CfWebSocket) {
    await this.webSocketClose(socket);
  }
}
