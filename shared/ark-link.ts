/**
 * Ark Link (#149): how a phone reaches the customer's own desktop ArkAgent.
 *
 * THE SHAPE. The desktop sits behind the customer's router, so nothing can call into it. It keeps one
 * outgoing WebSocket open to BlackArk's relay (one fixed host, for example `link.blackark.uk`). A
 * phone opens that host; the relay knows the phone by its device token and passes each HTTP request
 * and WebSocket to the paired desktop over the desktop's socket, multiplexed by stream id. So the
 * phone always gets the desktop's own app, its own version and its own sign-in.
 *
 *   phone ── https / wss ──▶ relay ◀── wss /_link/desk (outgoing from the desktop) ── desktop
 *
 * THIS FILE IS THE CONTRACT. The relay (`infra/ark-link`), the desktop connector
 * (`server/src/ark-link`), the Android app and the iOS shell all build against it. Anything that
 * changes what an older peer would understand bumps {@link ARK_LINK_PROTOCOL_VERSION}. Adding a new
 * message type does not: every side ignores a `t` it does not know.
 *
 * PAIRING.
 *  1. The desktop sends `pair.start`; the relay answers `pair.started {code, expiresAt}`: 8 characters
 *     from {@link PAIRING_CODE_ALPHABET}, single use, valid {@link PAIRING_TTL_MS}.
 *  2. The phone opens `/_link/pair` (the QR code carries `?code=`), and posts `/_link/pair/claim
 *     {code, deviceName}`. The relay spends the code and answers `{pairingId, status: "pending"}`, and
 *     tells the desktop `pair.claimed {pairingId, deviceName}`.
 *  3. A person at the desktop confirms the device name. The desktop makes the device token, keeps only
 *     its SHA-256, and sends `pair.confirm {pairingId, device, token}`.
 *  4. The phone polls `/_link/pair/status {pairingId}` and, once, receives `{status: "confirmed",
 *     deviceToken}` with the `ark_link` cookie set. The relay then forgets the token and keeps its hash.
 *
 * ROUTING. Every other request to the relay carries `Authorization: ArkLink <deviceToken>` (the iOS
 * shell, scripts) or the `ark_link` cookie (Chrome in the Android app). The relay maps the token's
 * hash to a desktop and forwards the request without that credential. The desktop checks the token
 * again against its own list, so a device removed on the desktop is cut at once.
 *
 * PAIRING IS NOT SIGN-IN. The desktop's own sign-in still applies to every request (see the decision
 * record, docs/ark/19-mobile.md, for desktops that run with no sign-in).
 *
 * Portable: no Node or Bun API, so the browser app, the relay and the server all import it.
 */

/** Bumped for any change an older peer would misread. The desktop says which it speaks when it connects. */
export const ARK_LINK_PROTOCOL_VERSION = 1;

/** On the desktop's socket handshake: the protocol version it speaks, as a decimal number. */
export const ARK_LINK_VERSION_HEADER = "ark-link-version";

/**
 * The relay's own paths. Everything else is the desktop's app.
 *
 * Under `/_link/` so the relay can never shadow a path of the app it carries. The two `.well-known`
 * files are where Android and iOS look, so they cannot move.
 */
export const ARK_LINK_PATHS = {
  /** WebSocket, desktop → relay. `Authorization: Bearer <install token>`, {@link ARK_LINK_VERSION_HEADER}. */
  desk: "/_link/desk",
  /** `GET` → `ok`. */
  health: "/_link/health",
  /** `GET`: the page a phone pairs on, in Greek and English. `?code=` fills the code in. */
  pairPage: "/_link/pair",
  /** `POST {code, deviceName}` → {@link PairClaimResponse}. */
  pairClaim: "/_link/pair/claim",
  /** `POST {pairingId}` → {@link PairStatusResponse}. */
  pairStatus: "/_link/pair/status",
  /** `POST`: forgets this phone's cookie (the desktop still lists the device until removed there). */
  forget: "/_link/forget",
  assetLinks: "/.well-known/assetlinks.json",
  appleAppSiteAssociation: "/.well-known/apple-app-site-association",
} as const;

/** The cookie Chrome carries the device token in. HttpOnly, Secure, SameSite=Lax, Path=/. */
export const DEVICE_COOKIE = "ark_link";
/** `Authorization: ArkLink <deviceToken>`. */
export const DEVICE_AUTH_SCHEME = "ArkLink";
/** How long the cookie lasts: Chrome's upper limit, 400 days. Renewed on every page load. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 3600;

/** No I, L, O, 0 or 1: a code is read off a screen and typed on a phone. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
/** How long a claimed pairing waits for the person at the desktop. */
export const PAIRING_CONFIRM_TTL_MS = 5 * 60_000;
/** A device name: what the person sees in Settings → Phones. */
export const DEVICE_NAME_MAX = 60;

/** Device and install tokens: a prefix (so a leaked one is recognisable) and 32 random bytes. */
export const DEVICE_TOKEN_PREFIX = "arkd_";
export const INSTALL_TOKEN_PREFIX = "arki_";
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

/** Close codes on the desktop's socket. */
export const DESK_CLOSE = {
  /** Another connection for the same install took over. Do not reconnect straight away. */
  replaced: 4000,
  /** The protocol version is not one the relay speaks. */
  version: 4002,
  /** The install was removed from the relay. */
  removed: 4003,
  /** The desktop stopped answering pings. */
  silent: 4004,
} as const;

/** Defaults the relay enforces. Each is configurable on the relay. */
export const ARK_LINK_LIMITS = {
  /** Largest request body a phone may send. The app's largest is a message with attachments. */
  maxRequestBytes: 16 * 1024 * 1024,
  /** Largest response body passed back. */
  maxResponseBytes: 64 * 1024 * 1024,
  /** One data frame's payload. */
  maxChunkBytes: 64 * 1024,
  /** One control frame. */
  maxControlBytes: 64 * 1024,
  /** One passed-through WebSocket message, either way. Larger ones close that socket (1009). */
  maxWsMessageBytes: 1024 * 1024,
  /** Requests and sockets open at once per device. */
  maxStreamsPerDevice: 32,
  /** Per device: a bucket of this many requests, refilled at `requestsPerMinute`. */
  burst: 120,
  requestsPerMinute: 600,
  /** An HTTP stream with no frame either way for this long is ended. The app's streams beat every 8 s. */
  httpIdleMs: 60_000,
  /** A passed-through WebSocket with no message either way for this long is closed. */
  wsIdleMs: 10 * 60_000,
  /** How long the relay waits for the desktop to answer a request's head. */
  headTimeoutMs: 30_000,
  /** The relay pings the desktop this often and drops it after two missed pongs. */
  pingEveryMs: 25_000,
} as const;

// ---- tokens and codes -------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const randomBytes = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

/** A new device token. Shown to the phone once; everyone else keeps its SHA-256. */
export function newDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + base64url(randomBytes(32));
}

/** A new install token, issued by BlackArk on the relay and typed into the desktop once. */
export function newInstallToken(): string {
  return INSTALL_TOKEN_PREFIX + base64url(randomBytes(32));
}

export const isDeviceToken = (value: string) =>
  value.startsWith(DEVICE_TOKEN_PREFIX) &&
  TOKEN_BODY.test(value.slice(DEVICE_TOKEN_PREFIX.length));

export const isInstallToken = (value: string) =>
  value.startsWith(INSTALL_TOKEN_PREFIX) &&
  TOKEN_BODY.test(value.slice(INSTALL_TOKEN_PREFIX.length));

/** SHA-256 as lower-case hex: how every token is stored. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A new pairing code, uniform over the alphabet (bytes that would bias it are thrown away).
 * `random` is for tests.
 */
export function newPairingCode(
  random: (length: number) => Uint8Array = randomBytes,
): string {
  const size = PAIRING_CODE_ALPHABET.length;
  const ceiling = 256 - (256 % size);
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of random(PAIRING_CODE_LENGTH * 2)) {
      if (byte >= ceiling) continue;
      code += PAIRING_CODE_ALPHABET[byte % size];
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
}

/**
 * What a person typed, as a code, or null. Upper-cases it and drops spaces and hyphens. A character
 * outside the alphabet (I, L, O, 0 and 1 included) makes it no code: nothing is guessed.
 */
export function normalisePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]+/g, "");
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const character of code)
    if (!PAIRING_CODE_ALPHABET.includes(character)) return null;
  return code;
}

/** `ABCD-EFGH`, the way the desktop shows it. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A device name as given, trimmed, without control characters, or null when nothing is left. */
export function cleanDeviceName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  const name = input.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) return null;
  return [...name].slice(0, DEVICE_NAME_MAX).join("");
}

/** The pairing page's address for a code: what the QR code holds. */
export function pairUrl(linkOrigin: string, code: string): string {
  return `${linkOrigin.replace(/\/+$/, "")}${ARK_LINK_PATHS.pairPage}?code=${encodeURIComponent(code)}`;
}

/** The device token a phone's request carries, from the header first and then the cookie. */
export function deviceTokenFrom(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization) {
    const [scheme, value] = authorization.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() === DEVICE_AUTH_SCHEME.toLowerCase())
      return value && isDeviceToken(value) ? value : null;
  }
  const cookie = cookieValue(headers.get("cookie"), DEVICE_COOKIE);
  return cookie && isDeviceToken(cookie) ? cookie : null;
}

/** One cookie's value from a `Cookie` header. */
export function cookieValue(
  header: string | null,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// ---- phone ↔ relay (JSON over HTTPS) ----------------------------------------------------------

export type PairClaimRequest = { code: string; deviceName: string };

export type PairClaimResponse =
  | { status: "pending"; pairingId: string; expiresAt: string }
  | { status: "refused"; reason: PairRefusal };

/**
 * Why a claim or a pairing did not go through. `unknown` covers a code that never existed, was
 * already used, or has expired: the relay does not say which, so a guess learns nothing.
 */
export type PairRefusal =
  | "unknown"
  | "offline"
  | "refused"
  | "expired"
  | "limited";

export type PairStatusRequest = { pairingId: string };

export type PairStatusResponse =
  | { status: "pending" }
  | { status: "confirmed"; deviceToken: string; deviceName: string }
  | { status: "refused"; reason: PairRefusal };

// ---- relay ↔ desktop: frames ------------------------------------------------------------------

/** Header pairs in order. A list, because `set-cookie` repeats. */
export type HeaderList = [string, string][];

/** relay → desktop */
export type RelayMessage =
  /** The socket is accepted. `linkOrigin` is the phone-facing origin, e.g. `https://link.blackark.uk`. */
  | { t: "hello"; v: number; installId: string; linkOrigin: string }
  /**
   * A phone's request. `s` is the stream id, unique on this socket while open. `device` is who sent it,
   * with the token so the desktop can check it against its own list. `ws` asks for a WebSocket, with
   * the protocols the phone offered. `body` says data frames and an `end` follow.
   */
  | {
      t: "req";
      s: number;
      method: string;
      path: string;
      headers: HeaderList;
      device: { id: string; token: string };
      ws?: { protocols: string[] };
      body: boolean;
    }
  /** The request body is complete. */
  | { t: "end"; s: number }
  /** The phone went away, or a limit was hit: stop work on the stream. */
  | { t: "cancel"; s: number }
  /** The phone closed its WebSocket. */
  | { t: "ws.close"; s: number; code: number; reason: string }
  /** Answer to `pair.start`. */
  | { t: "pair.started"; id: string; code: string; expiresAt: string }
  /** A phone claimed a code this desktop started. */
  | {
      t: "pair.claimed";
      pairingId: string;
      deviceName: string;
      expiresAt: string;
    }
  /** A pairing ended without a device: it expired, or the phone went away. */
  | { t: "pair.ended"; pairingId: string; reason: PairRefusal }
  | { t: "ping"; at: number };

/** desktop → relay */
export type DeskMessage =
  /** The head of the answer to stream `s`. Data frames and an `end` follow. */
  | { t: "res"; s: number; status: number; headers: HeaderList }
  | { t: "end"; s: number }
  /** The desktop's own WebSocket for stream `s` is open; the relay completes the phone's upgrade. */
  | { t: "ws.accept"; s: number; protocol: string }
  | { t: "ws.close"; s: number; code: number; reason: string }
  /** `id` is the desktop's own, echoed in `pair.started`. */
  | { t: "pair.start"; id: string }
  /** A person confirmed this device. `token` is handed to the phone once and not kept. */
  | {
      t: "pair.confirm";
      pairingId: string;
      device: { id: string; name: string; tokenSha256: string };
      token: string;
    }
  | { t: "pair.refuse"; pairingId: string }
  /** Every paired device, sent on connect and after any change. The relay replaces its list with it. */
  | { t: "devices"; devices: { id: string; tokenSha256: string }[] }
  | { t: "pong"; at: number };

/** Kinds of binary data frame. */
export const DATA_KIND = {
  /** Request body (relay → desktop) or response body (desktop → relay). */
  body: 1,
  /** A WebSocket text message, as UTF-8. */
  wsText: 2,
  /** A WebSocket binary message. */
  wsBinary: 3,
} as const;
export type DataKind = (typeof DATA_KIND)[keyof typeof DATA_KIND];

/**
 * A binary data frame: one byte kind, the stream id as 4 bytes big-endian, then the payload.
 * Control frames are JSON text frames; data never is, so bodies are not inflated by base64.
 */
export function encodeData(
  kind: DataKind,
  stream: number,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(1, stream >>> 0);
  frame.set(payload, 5);
  return frame;
}

export function decodeData(
  frame: ArrayBuffer | Uint8Array,
): { kind: DataKind; stream: number; payload: Uint8Array } | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < 5) return null;
  const kind = bytes[0] as number;
  if (kind !== 1 && kind !== 2 && kind !== 3) return null;
  const stream = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(1);
  return { kind: kind as DataKind, stream, payload: bytes.subarray(5) };
}

export function encodeControl(message: RelayMessage | DeskMessage): string {
  return JSON.stringify(message);
}

const isStream = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= 0xffffffff;
const isText = (value: unknown, max = 4096): value is string =>
  typeof value === "string" && value.length <= max;
const isHeaders = (value: unknown): value is HeaderList =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      isText(pair[0], 256) &&
      isText(pair[1], 16_384),
  );
const isCode = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1000 &&
  value <= 4999;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

function parse(text: string): Record<string, unknown> | null {
  if (text.length > ARK_LINK_LIMITS.maxControlBytes) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A frame from the desktop, checked, or null for anything malformed or unknown. */
export function decodeDeskMessage(text: string): DeskMessage | null {
  const m = parse(text);
  if (!m) return null;
  switch (m.t) {
    case "res":
      return isStream(m.s) &&
        typeof m.status === "number" &&
        Number.isInteger(m.status) &&
        m.status >= 100 &&
        m.status <= 599 &&
        isHeaders(m.headers)
        ? { t: "res", s: m.s, status: m.status, headers: m.headers }
        : null;
    case "end":
      return isStream(m.s) ? { t: "end", s: m.s } : null;
    case "ws.accept":
      return isStream(m.s) && isText(m.protocol, 256)
        ? { t: "ws.accept", s: m.s, protocol: m.protocol }
        : null;
    case "ws.close":
      return isStream(m.s) && isCode(m.code) && isText(m.reason, 123)
        ? { t: "ws.close", s: m.s, code: m.code, reason: m.reason }
        : null;
    case "pair.start":
      return isId(m.id) ? { t: "pair.start", id: m.id } : null;
    case "pair.confirm": {
      const device = m.device as Record<string, unknown> | undefined;
      const name = cleanDeviceName(device?.name);
      return isId(m.pairingId) &&
        device &&
        isId(device.id) &&
        name &&
        typeof device.tokenSha256 === "string" &&
        HEX64.test(device.tokenSha256) &&
        typeof m.token === "string" &&
        isDeviceToken(m.token)
        ? {
            t: "pair.confirm",
            pairingId: m.pairingId,
            device: { id: device.id, name, tokenSha256: device.tokenSha256 },
            token: m.token,
          }
        : null;
    }
    case "pair.refuse":
      return isId(m.pairingId)
        ? { t: "pair.refuse", pairingId: m.pairingId }
        : null;
    case "devices": {
      if (!Array.isArray(m.devices) || m.devices.length > 1000) return null;
      const devices: { id: string; tokenSha256: string }[] = [];
      for (const device of m.devices as Record<string, unknown>[]) {
        if (
          !device ||
          !isId(device.id) ||
          typeof device.tokenSha256 !== "string" ||
          !HEX64.test(device.tokenSha256)
        )
          return null;
        devices.push({ id: device.id, tokenSha256: device.tokenSha256 });
      }
      return { t: "devices", devices };
    }
    case "pong":
      return typeof m.at === "number" ? { t: "pong", at: m.at } : null;
    default:
      return null;
  }
}

const PAIR_REFUSALS = new Set<PairRefusal>([
  "unknown",
  "offline",
  "refused",
  "expired",
  "limited",
]);

/** A frame from the relay, checked, or null for anything malformed or unknown. */
export function decodeRelayMessage(text: string): RelayMessage | null {
  const m = parse(text);
  if (!m) return null;
  switch (m.t) {
    case "hello":
      return typeof m.v === "number" &&
        isText(m.installId, 64) &&
        isText(m.linkOrigin, 300)
        ? {
            t: "hello",
            v: m.v,
            installId: m.installId,
            linkOrigin: m.linkOrigin,
          }
        : null;
    case "req": {
      const device = m.device as Record<string, unknown> | undefined;
      const ws = m.ws as Record<string, unknown> | undefined;
      const method = typeof m.method === "string" ? m.method : "";
      if (
        !isStream(m.s) ||
        !/^[A-Z]{3,7}$/.test(method) ||
        !isText(m.path, 8192) ||
        !m.path.startsWith("/") ||
        !isHeaders(m.headers) ||
        !device ||
        !isId(device.id) ||
        typeof device.token !== "string" ||
        typeof m.body !== "boolean"
      )
        return null;
      if (
        ws !== undefined &&
        !(
          ws &&
          Array.isArray(ws.protocols) &&
          ws.protocols.every((p) => isText(p, 256))
        )
      )
        return null;
      return {
        t: "req",
        s: m.s,
        method,
        path: m.path,
        headers: m.headers,
        device: { id: device.id, token: device.token },
        ...(ws ? { ws: { protocols: ws.protocols as string[] } } : {}),
        body: m.body,
      };
    }
    case "end":
      return isStream(m.s) ? { t: "end", s: m.s } : null;
    case "cancel":
      return isStream(m.s) ? { t: "cancel", s: m.s } : null;
    case "ws.close":
      return isStream(m.s) && isCode(m.code) && isText(m.reason, 123)
        ? { t: "ws.close", s: m.s, code: m.code, reason: m.reason }
        : null;
    case "pair.started":
      return isId(m.id) &&
        typeof m.code === "string" &&
        normalisePairingCode(m.code) === m.code &&
        isText(m.expiresAt, 40)
        ? { t: "pair.started", id: m.id, code: m.code, expiresAt: m.expiresAt }
        : null;
    case "pair.claimed": {
      const name = cleanDeviceName(m.deviceName);
      return isId(m.pairingId) && name && isText(m.expiresAt, 40)
        ? {
            t: "pair.claimed",
            pairingId: m.pairingId,
            deviceName: name,
            expiresAt: m.expiresAt,
          }
        : null;
    }
    case "pair.ended":
      return isId(m.pairingId) &&
        typeof m.reason === "string" &&
        PAIR_REFUSALS.has(m.reason as PairRefusal)
        ? {
            t: "pair.ended",
            pairingId: m.pairingId,
            reason: m.reason as PairRefusal,
          }
        : null;
    case "ping":
      return typeof m.at === "number" ? { t: "ping", at: m.at } : null;
    default:
      return null;
  }
}

/**
 * Hop-by-hop headers, and the ones a proxy must set itself. Never passed across the link in either
 * direction.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  "sec-websocket-protocol",
]);

/**
 * A phone's request headers as the relay forwards them: without hop-by-hop headers, without the
 * device credential (the ArkLink authorization and the `ark_link` cookie), and without any
 * forwarding header a phone could forge.
 */
export function forwardableRequestHeaders(headers: Headers): HeaderList {
  const list: HeaderList = [];
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) return;
    if (
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name === "x-real-ip" ||
      name.startsWith("cf-")
    )
      return;
    if (name === "authorization") {
      const scheme = value.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (scheme === DEVICE_AUTH_SCHEME.toLowerCase()) return;
    }
    if (name === "cookie") {
      const kept = value
        .split(";")
        .map((part) => part.trim())
        .filter(
          (part) => part && part.split("=", 1)[0]?.trim() !== DEVICE_COOKIE,
        )
        .join("; ");
      if (kept) list.push([name, kept]);
      return;
    }
    list.push([name, value]);
  });
  return list;
}

/** A desktop's response headers as the relay passes them to the phone. It may not set the device cookie. */
export function forwardableResponseHeaders(list: HeaderList): HeaderList {
  return list.filter(([rawName, value]) => {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) return false;
    if (name === "set-cookie")
      return value.split("=", 1)[0]?.trim() !== DEVICE_COOKIE;
    return true;
  });
}
