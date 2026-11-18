/**
 * Ark Link relay (#149): lets a phone reach the customer's own desktop ArkAgent.
 *
 * WHY IT EXISTS. The desktop sits behind the customer's router, so a phone cannot call into it. The
 * desktop keeps one outgoing WebSocket open to this relay (`/_link/desk`); the relay passes each of a
 * paired phone's HTTP requests and WebSockets to it over that socket, multiplexed by stream id. The
 * wire contract is `shared/ark-link.ts`.
 *
 * WHAT IT HOLDS.
 * - `installs.json`: each install's id and the SHA-256 of its install token (BlackArk issues it).
 * - `devices.json`: each paired device's id, its install, and the SHA-256 of its device token. Routing
 *   only: the desktop holds the names and sends the whole list each time it connects, which replaces
 *   what is here.
 * - In memory: which desktops are connected, the pairing codes waiting (5 minutes), and the open
 *   streams. A device token passes through memory once, from the desktop to the phone, at pairing.
 * - Logs: when a desktop connects or drops, and pairings. Never a body, a path, a header or a token.
 *
 * WHAT IT TRUSTS.
 * - A desktop only with its install token (`Authorization: Bearer`), compared by SHA-256.
 * - A phone only with its device token (`Authorization: ArkLink`, or the `ark_link` cookie), by
 *   SHA-256. The token is taken off the request before it is forwarded, and the desktop checks it again.
 * - A pairing code only once, for 5 minutes, and only for the desktop that asked for it; and the device
 *   only once a person at that desktop confirmed it.
 *
 * LIMITS. Per device: a request bucket, a cap on open streams, request and response sizes, and idle
 * timeouts. Per address: pairing tries and unknown tokens. All in `ARK_LINK_LIMITS`.
 *
 * PHASE 1 IS TLS TO THE RELAY. The relay ends TLS (Caddy) and could read what passes. End-to-end
 * encryption between phone and desktop is phase 2 (see README.md).
 *
 * ONE PROCESS. State is per process; run one copy per host.
 */
import type { Server, ServerWebSocket } from "bun";
import {
  appleAppSiteAssociation,
  assetLinks,
  type MobileLinksConfig,
} from "../../server/src/mobile/links";
import {
  ARK_LINK_LIMITS,
  ARK_LINK_PATHS,
  ARK_LINK_PROTOCOL_VERSION,
  ARK_LINK_VERSION_HEADER,
  cleanDeviceName,
  DATA_KIND,
  DESK_CLOSE,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  type DeskMessage,
  decodeData,
  decodeDeskMessage,
  deviceTokenFrom,
  encodeControl,
  encodeData,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isInstallToken,
  newPairingCode,
  normalisePairingCode,
  PAIRING_CONFIRM_TTL_MS,
  PAIRING_TTL_MS,
  type PairRefusal,
  type RelayMessage,
  tokenHash,
} from "../../shared/ark-link";
import {
  NOT_PAIRED_PAGE,
  OFFLINE_PAGE,
  PAGE_POLICY,
  PAIR_PAGE,
  PAIR_SCRIPT,
} from "./pages";

export type Install = { id: string; tokenSha256: string };
export type DeviceRoute = {
  id: string;
  installId: string;
  tokenSha256: string;
};

/** Where device routes are kept between restarts. */
export type DeviceStore = {
  load(): DeviceRoute[];
  save(routes: DeviceRoute[]): void;
};

export type Limits = Record<keyof typeof ARK_LINK_LIMITS, number> & {
  /** Pairing claims per address per minute. */
  claimsPerMinute: number;
  /** Pairing status polls per address per minute. */
  pollsPerMinute: number;
  /** Requests with a token nobody knows, per address per minute. */
  unknownPerMinute: number;
};

export type LinkRelayConfig = {
  /** The origin phones open, e.g. `https://link.blackark.uk`. No trailing slash. */
  linkOrigin: string;
  installs: () => Install[];
  devices?: DeviceStore;
  limits?: Partial<Limits>;
  /** The store apps, for `assetlinks.json` and `apple-app-site-association`. */
  apps?: MobileLinksConfig;
  /** Behind Caddy, the phone's address is the first `X-Forwarded-For`. */
  trustProxy?: boolean;
  log?: (line: string) => void;
  now?: () => number;
};

type DeskData = { kind: "desk"; installId: string; version: number };
type PhoneData = { kind: "phone"; installId: string; s: number };
type SocketData = DeskData | PhoneData;

type HttpStream = {
  kind: "http";
  deviceId: string;
  head: (response: { status: number; headers: [string, string][] }) => void;
  fail: (status: number) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  nullBody: boolean;
  renewCookie?: string;
};

type WsStream = {
  kind: "ws";
  deviceId: string;
  accept?: (protocol: string | null) => void;
  phone?: ServerWebSocket<SocketData>;
  timer?: ReturnType<typeof setTimeout>;
};

type Stream = HttpStream | WsStream;

type Desk = {
  ws: ServerWebSocket<SocketData>;
  streams: Map<number, Stream>;
  next: number;
  lastPong: number;
  ping: ReturnType<typeof setInterval>;
};

type Waiting = { installId: string; deskId: string; expiresAt: number };
type Pairing = {
  installId: string;
  deviceName: string;
  expiresAt: number;
  state: "claimed" | "confirmed" | "refused";
  token?: string;
};

class Buckets {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private capacity: number,
    private perMinute: number,
    private now: () => number,
  ) {}
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.at) / 60_000) * this.perMinute,
    );
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  sweep() {
    const now = this.now();
    for (const [key, bucket] of this.buckets)
      if (now - bucket.at > 10 * 60_000) this.buckets.delete(key);
  }
}

const NULL_BODY = new Set([101, 204, 205, 304]);
const encoder = new TextEncoder();

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });

const html = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PAGE_POLICY,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });

/** Whether a person's browser is asking for a page, rather than a script for data. */
function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (
    request.method === "GET" &&
    (request.headers.get("accept") ?? "").includes("text/html")
  );
}

function deviceCookie(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearedCookie(secure: boolean): string {
  return `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

async function readBody(request: Request, max: number): Promise<unknown> {
  const text = await request.text();
  if (text.length > max) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createLinkRelay(config: LinkRelayConfig) {
  const limits: Limits = {
    ...ARK_LINK_LIMITS,
    claimsPerMinute: 10,
    pollsPerMinute: 120,
    unknownPerMinute: 60,
    ...config.limits,
  };
  const now = config.now ?? Date.now;
  const log = config.log ?? ((line: string) => console.log(line));
  const linkOrigin = config.linkOrigin.replace(/\/+$/, "");
  const secure = linkOrigin.startsWith("https:");

  const desks = new Map<string, Desk>();
  const routes = new Map<string, DeviceRoute>();
  for (const route of config.devices?.load() ?? [])
    routes.set(route.tokenSha256, route);
  const waiting = new Map<string, Waiting>();
  const pairings = new Map<string, Pairing>();

  const perDevice = new Buckets(limits.burst, limits.requestsPerMinute, now);
  const claims = new Buckets(
    limits.claimsPerMinute,
    limits.claimsPerMinute,
    now,
  );
  const polls = new Buckets(limits.pollsPerMinute, limits.pollsPerMinute, now);
  const unknown = new Buckets(
    limits.unknownPerMinute,
    limits.unknownPerMinute,
    now,
  );

  const record = (event: Record<string, unknown>) =>
    log(JSON.stringify({ at: new Date(now()).toISOString(), ...event }));

  function saveRoutes() {
    config.devices?.save([...routes.values()]);
  }

  function addressOf(request: Request, server: Server<SocketData>): string {
    if (config.trustProxy) {
      const first = request.headers
        .get("x-forwarded-for")
        ?.split(",")[0]
        ?.trim();
      if (first) return first;
    }
    return server.requestIP(request)?.address ?? "unknown";
  }

  function send(desk: Desk, message: RelayMessage) {
    desk.ws.send(encodeControl(message));
  }

  function streamsOf(desk: Desk, deviceId: string): number {
    let count = 0;
    for (const stream of desk.streams.values())
      if (stream.deviceId === deviceId) count++;
    return count;
  }

  // ---- streams ------------------------------------------------------------------------------

  function finish(desk: Desk, s: number) {
    const stream = desk.streams.get(s);
    if (!stream) return;
    if (stream.timer) clearTimeout(stream.timer);
    desk.streams.delete(s);
  }

  function idle(desk: Desk, s: number) {
    const stream = desk.streams.get(s);
    if (!stream) return;
    if (stream.timer) clearTimeout(stream.timer);
    const ms = stream.kind === "http" ? limits.httpIdleMs : limits.wsIdleMs;
    stream.timer = setTimeout(() => {
      const current = desk.streams.get(s);
      if (!current) return;
      send(desk, { t: "cancel", s });
      if (current.kind === "http") {
        current.fail(504);
        try {
          current.controller?.error(new Error("idle"));
        } catch {}
      } else {
        current.accept?.(null);
        current.phone?.close(1001, "idle");
      }
      finish(desk, s);
    }, ms);
  }

  /** Ends every stream of a desktop that went away, or of a device that was removed. */
  function dropStreams(desk: Desk, which: (stream: Stream) => boolean) {
    for (const [s, stream] of desk.streams) {
      if (!which(stream)) continue;
      if (stream.kind === "http") {
        stream.fail(503);
        try {
          stream.controller?.error(new Error("gone"));
        } catch {}
      } else {
        stream.accept?.(null);
        stream.phone?.close(1012, "gone");
      }
      finish(desk, s);
    }
  }

  // ---- phone requests -----------------------------------------------------------------------

  function notPaired(request: Request, clear: boolean): Response {
    const headers: HeadersInit = clear
      ? { "set-cookie": clearedCookie(secure) }
      : {};
    if (isNavigation(request))
      return clear
        ? html(NOT_PAIRED_PAGE, 401, headers)
        : new Response(null, {
            status: 302,
            headers: { location: ARK_LINK_PATHS.pairPage, ...headers },
          });
    return json(
      {
        error: "This phone is not paired with a computer.",
        code: "ark_link_not_paired",
      },
      401,
      headers,
    );
  }

  function offline(request: Request): Response {
    if (isNavigation(request))
      return html(OFFLINE_PAGE, 503, { "retry-after": "30" });
    return json(
      {
        error: "Your computer is not connected right now.",
        code: "ark_link_offline",
      },
      503,
      { "retry-after": "30" },
    );
  }

  async function forward(
    request: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    const token = deviceTokenFrom(request.headers);
    const address = addressOf(request, server);
    if (!token) {
      if (!unknown.take(address))
        return json({ error: "Too many requests." }, 429);
      return notPaired(request, false);
    }
    const route = routes.get(await tokenHash(token));
    if (!route) {
      if (!unknown.take(address))
        return json({ error: "Too many requests." }, 429);
      return notPaired(request, true);
    }
    if (!perDevice.take(route.id))
      return json(
        { error: "Too many requests.", code: "ark_link_limited" },
        429,
        {
          "retry-after": "5",
        },
      );
    const desk = desks.get(route.installId);
    if (!desk) return offline(request);
    if (streamsOf(desk, route.id) >= limits.maxStreamsPerDevice)
      return json(
        { error: "Too many requests.", code: "ark_link_limited" },
        429,
        {
          "retry-after": "5",
        },
      );

    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const headers = forwardableRequestHeaders(request.headers);
    const s = desk.next;
    desk.next = desk.next >= 0xfffffff0 ? 1 : desk.next + 1;

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const accepted = new Promise<string | null>((resolve) => {
        const stream: WsStream = { kind: "ws", deviceId: route.id };
        stream.accept = (protocol) => {
          stream.accept = undefined;
          resolve(protocol);
        };
        desk.streams.set(s, stream);
        stream.timer = setTimeout(() => {
          stream.accept?.(null);
        }, limits.headTimeoutMs);
      });
      send(desk, {
        t: "req",
        s,
        method: "GET",
        path,
        headers,
        device: { id: route.id, token },
        ws: { protocols },
        body: false,
      });
      const protocol = await accepted;
      const stream = desk.streams.get(s);
      if (protocol === null || !stream) {
        finish(desk, s);
        send(desk, { t: "cancel", s });
        return new Response("The computer did not accept the connection.", {
          status: 502,
        });
      }
      const ok = server.upgrade(request, {
        data: { kind: "phone", installId: route.installId, s },
        ...(protocol
          ? { headers: { "sec-websocket-protocol": protocol } }
          : {}),
      });
      if (!ok) {
        finish(desk, s);
        send(desk, { t: "cancel", s });
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      idle(desk, s);
      return undefined;
    }

    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > limits.maxRequestBytes)
      return json({ error: "That is too large to send." }, 413);

    const hasBody =
      request.body !== null &&
      request.method !== "GET" &&
      request.method !== "HEAD";
    let resolveHead!: (response: Response) => void;
    const answered = new Promise<Response>((resolve) => {
      resolveHead = resolve;
    });
    const usedCookie =
      !request.headers
        .get("authorization")
        ?.toLowerCase()
        .startsWith("arklink") && isNavigation(request);
    const stream: HttpStream = {
      kind: "http",
      deviceId: route.id,
      bytes: 0,
      nullBody: request.method === "HEAD",
      ...(usedCookie ? { renewCookie: deviceCookie(token, secure) } : {}),
      fail: (status) => {
        stream.head = () => undefined;
        stream.fail = () => undefined;
        resolveHead(
          status === 503
            ? offline(request)
            : json({ error: "The computer did not answer in time." }, status),
        );
      },
      head: ({ status, headers: list }) => {
        stream.head = () => undefined;
        stream.fail = () => undefined;
        const out = new Headers();
        for (const [name, value] of forwardableResponseHeaders(list))
          out.append(name, value);
        if (stream.renewCookie) out.append("set-cookie", stream.renewCookie);
        if (stream.nullBody || NULL_BODY.has(status)) {
          stream.nullBody = true;
          resolveHead(new Response(null, { status, headers: out }));
          return;
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stream.controller = controller;
          },
          cancel() {
            if (desk.streams.get(s) === stream) {
              send(desk, { t: "cancel", s });
              finish(desk, s);
            }
          },
        });
        resolveHead(new Response(body, { status, headers: out }));
      },
    };
    desk.streams.set(s, stream);
    request.signal.addEventListener("abort", () => {
      if (desk.streams.get(s) !== stream) return;
      send(desk, { t: "cancel", s });
      finish(desk, s);
    });
    const headTimer = setTimeout(() => {
      if (desk.streams.get(s) !== stream || stream.controller) return;
      stream.fail(504);
    }, limits.headTimeoutMs);
    answered.finally(() => clearTimeout(headTimer));

    send(desk, {
      t: "req",
      s,
      method: request.method,
      path,
      headers,
      device: { id: route.id, token },
      body: hasBody,
    });
    idle(desk, s);

    if (hasBody && request.body) {
      let total = 0;
      try {
        for await (const chunk of request.body) {
          total += chunk.byteLength;
          if (total > limits.maxRequestBytes) {
            send(desk, { t: "cancel", s });
            finish(desk, s);
            return json({ error: "That is too large to send." }, 413);
          }
          for (let at = 0; at < chunk.byteLength; at += limits.maxChunkBytes) {
            if (desk.streams.get(s) !== stream) break;
            desk.ws.send(
              encodeData(
                DATA_KIND.body,
                s,
                chunk.subarray(at, at + limits.maxChunkBytes),
              ),
            );
          }
          idle(desk, s);
        }
      } catch {
        send(desk, { t: "cancel", s });
        finish(desk, s);
        return json({ error: "The request was cut off." }, 400);
      }
      if (desk.streams.get(s) === stream) send(desk, { t: "end", s });
    }
    return answered;
  }

  // ---- pairing ------------------------------------------------------------------------------

  async function claim(request: Request, server: Server<SocketData>) {
    if (!claims.take(addressOf(request, server)))
      return json({ status: "refused", reason: "limited" }, 429);
    const body = (await readBody(request, 2048)) as Record<
      string,
      unknown
    > | null;
    const code =
      typeof body?.code === "string" ? normalisePairingCode(body.code) : null;
    const deviceName = cleanDeviceName(body?.deviceName);
    if (!code || !deviceName)
      return json({ status: "refused", reason: "unknown" }, 400);
    const found = waiting.get(code);
    if (!found || found.expiresAt <= now())
      return json({ status: "refused", reason: "unknown" }, 404);
    const desk = desks.get(found.installId);
    if (!desk) return json({ status: "refused", reason: "offline" }, 503);
    // Spent now, whatever happens next.
    waiting.delete(code);
    const pairingId = randomId();
    const expiresAt = now() + PAIRING_CONFIRM_TTL_MS;
    pairings.set(pairingId, {
      installId: found.installId,
      deviceName,
      expiresAt,
      state: "claimed",
    });
    send(desk, {
      t: "pair.claimed",
      pairingId,
      deviceName,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    record({ type: "pair.claimed", install: found.installId });
    return json({
      status: "pending",
      pairingId,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  function endPairing(pairingId: string, reason: PairRefusal) {
    const pairing = pairings.get(pairingId);
    if (!pairing) return;
    pairings.delete(pairingId);
    const desk = desks.get(pairing.installId);
    if (desk && pairing.state === "claimed")
      send(desk, { t: "pair.ended", pairingId, reason });
  }

  async function status(request: Request, server: Server<SocketData>) {
    if (!polls.take(addressOf(request, server)))
      return json({ status: "refused", reason: "limited" }, 429);
    const body = (await readBody(request, 1024)) as Record<
      string,
      unknown
    > | null;
    const pairingId = typeof body?.pairingId === "string" ? body.pairingId : "";
    const pairing = pairings.get(pairingId);
    if (!pairing) return json({ status: "refused", reason: "unknown" }, 404);
    if (pairing.state === "confirmed" && pairing.token) {
      // Handed over once, then forgotten.
      const token = pairing.token;
      pairings.delete(pairingId);
      return json(
        {
          status: "confirmed",
          deviceToken: token,
          deviceName: pairing.deviceName,
        },
        200,
        { "set-cookie": deviceCookie(token, secure) },
      );
    }
    if (pairing.state === "refused") {
      pairings.delete(pairingId);
      return json({ status: "refused", reason: "refused" });
    }
    if (pairing.expiresAt <= now()) {
      endPairing(pairingId, "expired");
      return json({ status: "refused", reason: "expired" });
    }
    return json({ status: "pending" });
  }

  // ---- the desktop's messages ---------------------------------------------------------------

  async function onDeskMessage(
    desk: Desk,
    installId: string,
    message: DeskMessage,
  ) {
    switch (message.t) {
      case "res": {
        const stream = desk.streams.get(message.s);
        if (stream?.kind !== "http") return;
        stream.head({ status: message.status, headers: message.headers });
        idle(desk, message.s);
        return;
      }
      case "end": {
        const stream = desk.streams.get(message.s);
        if (stream?.kind !== "http") return;
        try {
          stream.controller?.close();
        } catch {}
        finish(desk, message.s);
        return;
      }
      case "ws.accept": {
        const stream = desk.streams.get(message.s);
        if (stream?.kind !== "ws") return;
        if (stream.timer) clearTimeout(stream.timer);
        stream.accept?.(message.protocol);
        return;
      }
      case "ws.close": {
        const stream = desk.streams.get(message.s);
        if (stream?.kind !== "ws") return;
        stream.accept?.(null);
        stream.phone?.close(
          message.code >= 3000 || message.code === 1000 ? message.code : 1011,
          message.reason,
        );
        finish(desk, message.s);
        return;
      }
      case "pair.start": {
        for (const [code, entry] of waiting)
          if (entry.installId === installId) waiting.delete(code);
        let code = newPairingCode();
        while (waiting.has(code)) code = newPairingCode();
        const expiresAt = now() + PAIRING_TTL_MS;
        waiting.set(code, { installId, deskId: message.id, expiresAt });
        send(desk, {
          t: "pair.started",
          id: message.id,
          code,
          expiresAt: new Date(expiresAt).toISOString(),
        });
        record({ type: "pair.started", install: installId });
        return;
      }
      case "pair.confirm": {
        const pairing = pairings.get(message.pairingId);
        if (
          !pairing ||
          pairing.installId !== installId ||
          pairing.state !== "claimed" ||
          pairing.expiresAt <= now() ||
          (await tokenHash(message.token)) !== message.device.tokenSha256
        )
          return;
        pairing.state = "confirmed";
        pairing.token = message.token;
        pairing.deviceName = message.device.name;
        routes.set(message.device.tokenSha256, {
          id: message.device.id,
          installId,
          tokenSha256: message.device.tokenSha256,
        });
        saveRoutes();
        record({
          type: "pair.confirmed",
          install: installId,
          device: message.device.id,
        });
        return;
      }
      case "pair.refuse": {
        const pairing = pairings.get(message.pairingId);
        if (pairing?.installId === installId && pairing.state === "claimed")
          pairing.state = "refused";
        return;
      }
      case "devices": {
        const kept = new Set(message.devices.map((d) => d.tokenSha256));
        const ids = new Set(message.devices.map((d) => d.id));
        for (const [hash, route] of routes)
          if (route.installId === installId && !kept.has(hash))
            routes.delete(hash);
        for (const device of message.devices) {
          const existing = routes.get(device.tokenSha256);
          // A hash already routed to another install stays where it is.
          if (existing && existing.installId !== installId) continue;
          routes.set(device.tokenSha256, { ...device, installId });
        }
        saveRoutes();
        dropStreams(desk, (stream) => !ids.has(stream.deviceId));
        return;
      }
      case "pong":
        desk.lastPong = now();
        return;
    }
  }

  function onDeskData(desk: Desk, raw: Uint8Array) {
    const frame = decodeData(raw);
    if (!frame) return;
    const stream = desk.streams.get(frame.stream);
    if (!stream) return;
    if (stream.kind === "http") {
      if (frame.kind !== DATA_KIND.body || stream.nullBody) return;
      stream.bytes += frame.payload.byteLength;
      if (stream.bytes > limits.maxResponseBytes) {
        send(desk, { t: "cancel", s: frame.stream });
        try {
          stream.controller?.error(new Error("too large"));
        } catch {}
        finish(desk, frame.stream);
        return;
      }
      try {
        stream.controller?.enqueue(frame.payload.slice());
      } catch {
        send(desk, { t: "cancel", s: frame.stream });
        finish(desk, frame.stream);
        return;
      }
      idle(desk, frame.stream);
      return;
    }
    if (!stream.phone) return;
    if (frame.kind === DATA_KIND.wsText)
      stream.phone.send(new TextDecoder().decode(frame.payload));
    else if (frame.kind === DATA_KIND.wsBinary)
      stream.phone.send(frame.payload.slice());
    idle(desk, frame.stream);
  }

  // ---- the server ---------------------------------------------------------------------------

  async function deskUpgrade(request: Request, server: Server<SocketData>) {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!isInstallToken(token))
      return new Response("Unauthorized.", { status: 401 });
    const hash = await tokenHash(token);
    const install = config
      .installs()
      .find((entry) => sameHex(entry.tokenSha256, hash));
    if (!install) return new Response("Unauthorized.", { status: 401 });
    const version = Number(request.headers.get(ARK_LINK_VERSION_HEADER) ?? 0);
    if (
      server.upgrade(request, {
        data: { kind: "desk", installId: install.id, version },
      })
    )
      return undefined;
    return new Response("Expected a WebSocket upgrade.", { status: 400 });
  }

  function linksResponse(kind: "android" | "ios"): Response {
    const apps = config.apps;
    if (kind === "android" && apps?.android)
      return json(assetLinks(apps.android), 200, {
        "cache-control": "max-age=300",
      });
    if (kind === "ios" && apps?.ios)
      return json(appleAppSiteAssociation(apps.ios), 200, {
        "cache-control": "max-age=300",
      });
    return new Response("Not found.", { status: 404 });
  }

  async function fetch(
    request: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === ARK_LINK_PATHS.health) return new Response("ok");
    if (path === ARK_LINK_PATHS.assetLinks) return linksResponse("android");
    if (path === ARK_LINK_PATHS.appleAppSiteAssociation)
      return linksResponse("ios");
    if (path === ARK_LINK_PATHS.desk) return deskUpgrade(request, server);
    if (path.startsWith("/_link/")) {
      if (path === ARK_LINK_PATHS.pairPage && request.method === "GET")
        return html(PAIR_PAGE);
      if (path === "/_link/pair.js" && request.method === "GET")
        return new Response(PAIR_SCRIPT, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          },
        });
      if (request.method === "POST" && !sameSite(request))
        return json({ error: "This request came from another website." }, 403);
      if (path === ARK_LINK_PATHS.pairClaim && request.method === "POST")
        return claim(request, server);
      if (path === ARK_LINK_PATHS.pairStatus && request.method === "POST")
        return status(request, server);
      if (path === ARK_LINK_PATHS.forget && request.method === "POST")
        return json({ ok: true }, 200, { "set-cookie": clearedCookie(secure) });
      return new Response("Not found.", { status: 404 });
    }
    return forward(request, server);
  }

  /** The relay's own writes come from its own pages, or from an app that sends no Origin. */
  function sameSite(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (origin === null) return true;
    return origin === linkOrigin || origin === new URL(request.url).origin;
  }

  const websocket = {
    maxPayloadLength:
      Math.max(limits.maxWsMessageBytes, limits.maxChunkBytes) + 1024,
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "desk") {
        if (data.version !== ARK_LINK_PROTOCOL_VERSION) {
          ws.close(
            DESK_CLOSE.version,
            `This relay speaks Ark Link ${ARK_LINK_PROTOCOL_VERSION}.`,
          );
          return;
        }
        const previous = desks.get(data.installId);
        if (previous) {
          dropStreams(previous, () => true);
          clearInterval(previous.ping);
          desks.delete(data.installId);
          previous.ws.close(
            DESK_CLOSE.replaced,
            "Another connection took over.",
          );
        }
        const desk: Desk = {
          ws,
          streams: new Map(),
          next: 1,
          lastPong: now(),
          ping: setInterval(() => {
            if (now() - desk.lastPong > limits.pingEveryMs * 2.5) {
              ws.close(DESK_CLOSE.silent, "No answer to pings.");
              return;
            }
            send(desk, { t: "ping", at: now() });
          }, limits.pingEveryMs),
        };
        desks.set(data.installId, desk);
        send(desk, {
          t: "hello",
          v: ARK_LINK_PROTOCOL_VERSION,
          installId: data.installId,
          linkOrigin,
        });
        record({ type: "desk.connected", install: data.installId });
        return;
      }
      const desk = desks.get(data.installId);
      const stream = desk?.streams.get(data.s);
      if (!desk || stream?.kind !== "ws") {
        ws.close(1011, "gone");
        return;
      }
      stream.phone = ws;
    },
    message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
      const data = ws.data;
      const desk = desks.get(data.installId);
      if (data.kind === "desk") {
        if (!desk || desk.ws !== ws) return;
        if (typeof raw === "string") {
          const message = decodeDeskMessage(raw);
          if (message) void onDeskMessage(desk, data.installId, message);
          return;
        }
        onDeskData(desk, new Uint8Array(raw));
        return;
      }
      if (!desk?.streams.has(data.s)) {
        ws.close(1011, "gone");
        return;
      }
      const bytes =
        typeof raw === "string" ? encoder.encode(raw) : new Uint8Array(raw);
      if (bytes.byteLength > limits.maxWsMessageBytes) {
        ws.close(1009, "too large");
        return;
      }
      desk.ws.send(
        encodeData(
          typeof raw === "string" ? DATA_KIND.wsText : DATA_KIND.wsBinary,
          data.s,
          bytes,
        ),
      );
      idle(desk, data.s);
    },
    close(ws: ServerWebSocket<SocketData>, code: number, reason: string) {
      const data = ws.data;
      const desk = desks.get(data.installId);
      if (data.kind === "desk") {
        if (!desk || desk.ws !== ws) return;
        clearInterval(desk.ping);
        dropStreams(desk, () => true);
        desks.delete(data.installId);
        for (const [code, entry] of waiting)
          if (entry.installId === data.installId) waiting.delete(code);
        record({ type: "desk.dropped", install: data.installId });
        return;
      }
      if (!desk?.streams.has(data.s)) return;
      send(desk, {
        t: "ws.close",
        s: data.s,
        code:
          code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
            ? code
            : 1000,
        reason: (reason ?? "").slice(0, 123),
      });
      finish(desk, data.s);
    },
  };

  /** A desktop whose install BlackArk removed is dropped, and its phones see it as offline. */
  function dropRemovedInstalls() {
    const known = new Set(config.installs().map((entry) => entry.id));
    for (const [installId, desk] of desks)
      if (!known.has(installId))
        desk.ws.close(DESK_CLOSE.removed, "This install was removed.");
  }

  const sweeper = setInterval(() => {
    dropRemovedInstalls();
    const at = now();
    for (const [code, entry] of waiting)
      if (entry.expiresAt <= at) waiting.delete(code);
    for (const [id, pairing] of pairings)
      if (pairing.expiresAt <= at) endPairing(id, "expired");
    perDevice.sweep();
    claims.sweep();
    polls.sweep();
    unknown.sweep();
  }, 30_000);

  return {
    fetch,
    websocket,
    /** For tests and shutdown. */
    stop() {
      clearInterval(sweeper);
      for (const desk of desks.values()) {
        clearInterval(desk.ping);
        desk.ws.close(1001, "relay stopping");
      }
    },
    /** For tests: what is connected and routed. */
    get connected() {
      return [...desks.keys()];
    },
    get routed() {
      return [...routes.values()];
    },
  };
}

export type LinkRelay = ReturnType<typeof createLinkRelay>;
