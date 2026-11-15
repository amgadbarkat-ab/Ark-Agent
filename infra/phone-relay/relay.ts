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

export type Line = {
  /** A short name for logs, e.g. "wine24". */
  name: string;
  /** The Twilio number calls arrive on, E.164, e.g. "+302101234567". */
  number: string;
  /** SHA-256 (hex) of the line token the install presents. */
  tokenSha256: string;
  /** Where a call goes when the install hands it over, or is not connected. E.164. Optional. */
  fallback?: string;
};

export type RelayConfig = {
  accountSid: string;
  authToken: string;
  /** e.g. "https://phone.blackark.uk", with no trailing slash. */
  publicBaseUrl: string;
  lines: () => Line[];
  /** Twilio's REST API, swapped in tests. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
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

function handOver(line: Line | undefined): string {
  return line?.fallback && E164.test(line.fallback)
    ? `<Dial>${xml(line.fallback)}</Dial>`
    : SORRY;
}

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
          (typeof line.fallback === "string" && E164.test(line.fallback))),
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
      if (!desks.has(line.name)) {
        log(
          `call ${callId} line=${line.name}: install not connected, handed over`,
        );
        return twiml(handOver(line));
      }
      const key = randomBytes(24).toString("base64url");
      pending.set(key, { callId, line, from: form.From ?? "", at: Date.now() });
      const host = new URL(config.publicBaseUrl).host;
      return twiml(
        `<Connect><Stream url="wss://${xml(host)}/twilio/media"><Parameter name="key" value="${xml(key)}"/></Stream></Connect>${handOver(line)}`,
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
      }
      return new Response(null, { status: 204 });
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
        void redirect(message.callId, handOver(call.line)).then((ok) =>
          log(
            `call ${message.callId} line=${call.line.name}: hand-over ${ok ? "sent" : "failed"}`,
          ),
        );
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
          void redirect(entry.callId, handOver(entry.line));
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
            void redirect(callId, handOver(line));
        }
        return;
      }
      const callId = (socket.data as { callId?: string }).callId;
      if (callId) endCall(callId, "stream closed");
    },
  };

  return { fetch: fetchHandler, websocket, state: { desks, pending, calls } };
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
  });
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8080),
    fetch: relay.fetch,
    websocket: relay.websocket,
  });
  console.log(`phone relay listening on ${server.port}`);
}
