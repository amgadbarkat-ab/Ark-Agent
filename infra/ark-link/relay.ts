/**
 * Ark Link relay (#149), on Bun: lets a phone reach the customer's own desktop ArkAgent.
 *
 * WHY IT EXISTS. The desktop sits behind the customer's router, so a phone cannot call into it. The
 * desktop keeps one outgoing WebSocket open to this relay (`/_link/desk`); the relay passes each of a
 * paired phone's HTTP requests and WebSockets to it over that socket, multiplexed by stream id. The
 * wire contract is `shared/ark-link.ts`.
 *
 * THE SAME RELAY TWICE. This file is the Bun one (one process, behind Caddy); `worker/` is the
 * Cloudflare Workers one. Both are thin over the shared parts: `desk-link.ts` (one desktop's streams),
 * `directory.ts` (routes and pairings) and `edge.ts` (the relay's own paths). What is left here is how
 * Bun accepts and keeps sockets, and the in-memory maps.
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
import type { MobileLinksConfig } from "../../server/src/mobile/links";
import {
  ARK_LINK_PROTOCOL_VERSION,
  ARK_LINK_VERSION_HEADER,
  DESK_CLOSE,
  type DeskMessage,
  decodeDeskMessage,
  deviceTokenFrom,
  encodeControl,
  isInstallToken,
  type RelayMessage,
  tokenHash,
} from "../../shared/ark-link";
import {
  Buckets,
  DeskLink,
  type DeviceRoute,
  json,
  type Limits,
  limited,
  limitsWith,
  notPaired,
  offline,
  sameHex,
} from "./desk-link";
import { Directory, memoryDirectoryStore } from "./directory";
import {
  claimResponse,
  ownRoute,
  readClaim,
  readPairingId,
  statusResponse,
} from "./edge";

export type { DeviceRoute, Limits } from "./desk-link";
export type Install = { id: string; tokenSha256: string };

/** Where device routes are kept between restarts. */
export type DeviceStore = {
  load(): DeviceRoute[];
  save(routes: DeviceRoute[]): void;
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

type Desk = {
  ws: ServerWebSocket<SocketData>;
  link: DeskLink;
  lastPong: number;
  ping: ReturnType<typeof setInterval>;
};

export function createLinkRelay(config: LinkRelayConfig) {
  const limits = limitsWith(config.limits);
  const now = config.now ?? Date.now;
  const log = config.log ?? ((line: string) => console.log(line));
  const linkOrigin = config.linkOrigin.replace(/\/+$/, "");
  const secure = linkOrigin.startsWith("https:");
  const edge = { linkOrigin, apps: config.apps };

  const desks = new Map<string, Desk>();
  const directory = new Directory(
    memoryDirectoryStore(config.devices?.load() ?? [], (routes) =>
      config.devices?.save(routes),
    ),
    now,
  );

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

  // ---- phone requests -----------------------------------------------------------------------

  async function forward(
    request: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    const token = deviceTokenFrom(request.headers);
    const address = addressOf(request, server);
    if (!token) {
      if (!unknown.take(address))
        return json({ error: "Too many requests." }, 429);
      return notPaired(request, false, secure);
    }
    const route = directory.lookup(await tokenHash(token));
    if (!route) {
      if (!unknown.take(address))
        return json({ error: "Too many requests." }, 429);
      return notPaired(request, true, secure);
    }
    if (!perDevice.take(route.id)) return limited();
    const desk = desks.get(route.installId);
    if (!desk) return offline(request);
    if (desk.link.openFor(route.id) >= limits.maxStreamsPerDevice)
      return limited();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const opened = await desk.link.openSocket(request, route, token);
      if (!opened)
        return new Response("The computer did not accept the connection.", {
          status: 502,
        });
      const ok = server.upgrade(request, {
        data: { kind: "phone", installId: route.installId, s: opened.s },
        ...(opened.protocol
          ? { headers: { "sec-websocket-protocol": opened.protocol } }
          : {}),
      });
      if (!ok) {
        desk.link.abandon(opened.s);
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      return undefined;
    }
    return desk.link.forwardHttp(request, route, token);
  }

  // ---- pairing ------------------------------------------------------------------------------

  async function claim(request: Request, server: Server<SocketData>) {
    if (!claims.take(addressOf(request, server)))
      return json({ status: "refused", reason: "limited" }, 429);
    const read = await readClaim(request);
    if (read instanceof Response) return read;
    const installId = directory.peek(read.code);
    if (!installId)
      return claimResponse({ ok: false, reason: "unknown", status: 404 });
    const desk = desks.get(installId);
    if (!desk)
      return claimResponse({ ok: false, reason: "offline", status: 503 });
    const answer = directory.claim(read.code, read.deviceName);
    if (answer.ok) {
      send(desk, {
        t: "pair.claimed",
        pairingId: answer.pairingId,
        deviceName: read.deviceName,
        expiresAt: new Date(answer.expiresAt).toISOString(),
      });
      record({ type: "pair.claimed", install: installId });
    }
    return claimResponse(answer);
  }

  async function status(request: Request, server: Server<SocketData>) {
    if (!polls.take(addressOf(request, server)))
      return json({ status: "refused", reason: "limited" }, 429);
    const answer = directory.status(await readPairingId(request));
    if (answer.status === "refused" && answer.ended) {
      const desk = desks.get(answer.ended.installId);
      if (desk)
        send(desk, {
          t: "pair.ended",
          pairingId: answer.ended.pairingId,
          reason: answer.ended.reason,
        });
    }
    return statusResponse(answer, secure);
  }

  // ---- the desktop's messages ---------------------------------------------------------------

  async function onDeskMessage(
    desk: Desk,
    installId: string,
    message: DeskMessage,
  ) {
    if (desk.link.onDeskMessage(message)) return;
    switch (message.t) {
      case "pair.start": {
        const started = directory.startPairing(installId, message.id);
        send(desk, {
          t: "pair.started",
          id: message.id,
          code: started.code,
          expiresAt: new Date(started.expiresAt).toISOString(),
        });
        record({ type: "pair.started", install: installId });
        return;
      }
      case "pair.confirm":
        if (await directory.confirm(installId, message))
          record({
            type: "pair.confirmed",
            install: installId,
            device: message.device.id,
          });
        return;
      case "pair.refuse":
        directory.refuse(installId, message.pairingId);
        return;
      case "devices": {
        const ids = directory.syncDevices(installId, message.devices);
        desk.link.drop((deviceId) => !ids.has(deviceId));
        return;
      }
      case "pong":
        desk.lastPong = now();
        return;
      case "beat":
        send(desk, { t: "beat" });
        return;
    }
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

  async function fetch(
    request: Request,
    server: Server<SocketData>,
  ): Promise<Response | undefined> {
    const own = ownRoute(request, edge);
    if (own instanceof Response) return own;
    if (own === "desk") return deskUpgrade(request, server);
    if (own === "claim") return claim(request, server);
    if (own === "status") return status(request, server);
    return forward(request, server);
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
          previous.link.drop();
          clearInterval(previous.ping);
          desks.delete(data.installId);
          previous.ws.close(
            DESK_CLOSE.replaced,
            "Another connection took over.",
          );
        }
        const desk: Desk = {
          ws,
          link: new DeskLink({
            send: (frame) => ws.send(frame),
            limits,
            secure,
          }),
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
          ...(config.apps?.android
            ? { androidPackage: config.apps.android.appId }
            : {}),
        });
        record({ type: "desk.connected", install: data.installId });
        return;
      }
      const desk = desks.get(data.installId);
      if (!desk) {
        ws.close(1011, "gone");
        return;
      }
      desk.link.attachPhone(data.s, {
        send: (frame) => ws.send(frame),
        close: (code, reason) => ws.close(code, reason),
      });
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
        desk.link.onDeskData(new Uint8Array(raw));
        return;
      }
      const passed = desk
        ? desk.link.fromPhone(
            data.s,
            typeof raw === "string" ? raw : new Uint8Array(raw),
          )
        : false;
      if (passed === "too-large") ws.close(1009, "too large");
      else if (!passed) ws.close(1011, "gone");
    },
    close(ws: ServerWebSocket<SocketData>, code: number, reason: string) {
      const data = ws.data;
      const desk = desks.get(data.installId);
      if (data.kind === "desk") {
        if (!desk || desk.ws !== ws) return;
        clearInterval(desk.ping);
        desk.link.drop();
        desks.delete(data.installId);
        directory.forgetCodesOf(data.installId);
        record({ type: "desk.dropped", install: data.installId });
        return;
      }
      desk?.link.phoneClosed(data.s, code, reason);
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
    for (const ended of directory.sweep()) {
      const desk = desks.get(ended.installId);
      if (desk)
        send(desk, {
          t: "pair.ended",
          pairingId: ended.pairingId,
          reason: ended.reason,
        });
    }
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
      return directory.routes;
    },
  };
}

export type LinkRelay = ReturnType<typeof createLinkRelay>;
