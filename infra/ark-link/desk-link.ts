/**
 * One connected desktop's side of the relay (#149), with no server API in it: the streams it carries,
 * a phone's HTTP request made into frames and the answer made back into a `Response`, and a phone's
 * WebSocket bridged to the desktop's. Shared by the Bun relay (`relay.ts`) and the Workers relay
 * (`worker/install.ts`), which differ only in how sockets are accepted and kept.
 *
 * The platform gives it `send` (onto the desktop's socket) and, for a phone's WebSocket, a
 * {@link PhoneSocket} once it has upgraded the phone.
 */
import {
  ARK_LINK_LIMITS,
  DATA_KIND,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  type DeskMessage,
  decodeData,
  encodeControl,
  encodeData,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  type RelayMessage,
} from "../../shared/ark-link";
import { NOT_PAIRED_PAGE, OFFLINE_PAGE, PAGE_POLICY } from "./pages";

export type Limits = Record<keyof typeof ARK_LINK_LIMITS, number> & {
  /** Pairing claims per address per minute. */
  claimsPerMinute: number;
  /** Pairing status polls per address per minute. */
  pollsPerMinute: number;
  /** Requests with a token nobody knows, per address per minute. */
  unknownPerMinute: number;
};

export function limitsWith(overrides: Partial<Limits> = {}): Limits {
  return {
    ...ARK_LINK_LIMITS,
    claimsPerMinute: 10,
    pollsPerMinute: 120,
    unknownPerMinute: 60,
    ...overrides,
  };
}

export type DeviceRoute = {
  id: string;
  installId: string;
  tokenSha256: string;
};

/** What the relay needs of a phone's WebSocket once the platform has accepted it. */
export type PhoneSocket = {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
};

// ---- small helpers both relays use -------------------------------------------------------------

export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });

export const html = (body: string, status = 200, headers: HeadersInit = {}) =>
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
export function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (
    request.method === "GET" &&
    (request.headers.get("accept") ?? "").includes("text/html")
  );
}

export function deviceCookie(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export async function readBody(
  request: Request,
  max: number,
): Promise<unknown> {
  const text = await request.text();
  if (text.length > max) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Token buckets by key, refilled continuously. */
export class Buckets {
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

export function notPaired(
  request: Request,
  clear: boolean,
  secure: boolean,
): Response {
  const headers: HeadersInit = clear
    ? { "set-cookie": clearedCookie(secure) }
    : {};
  if (isNavigation(request))
    return clear
      ? html(NOT_PAIRED_PAGE, 401, headers)
      : new Response(null, {
          status: 302,
          headers: { location: "/_link/pair", ...headers },
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

export function offline(request: Request): Response {
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

export const limited = () =>
  json({ error: "Too many requests.", code: "ark_link_limited" }, 429, {
    "retry-after": "5",
  });

// ---- the streams of one desktop -----------------------------------------------------------------

const NULL_BODY = new Set([101, 204, 205, 304]);
const encoder = new TextEncoder();

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
  phone?: PhoneSocket;
  timer?: ReturnType<typeof setTimeout>;
};

type Stream = HttpStream | WsStream;

export class DeskLink {
  private streams = new Map<number, Stream>();
  private next: number;

  constructor(
    private options: {
      /** Onto the desktop's socket. */
      send: (data: string | Uint8Array) => void;
      limits: Limits;
      secure: boolean;
      /** The first stream id to use; after a Durable Object wakes, past the sockets it kept. */
      firstStream?: number;
    },
  ) {
    this.next = options.firstStream ?? 1;
  }

  private control(message: RelayMessage) {
    this.options.send(encodeControl(message));
  }

  private streamId(): number {
    const s = this.next;
    this.next = this.next >= 0xfffffff0 ? 1 : this.next + 1;
    return s;
  }

  /** Requests and sockets open for this device. */
  openFor(deviceId: string): number {
    let count = 0;
    for (const stream of this.streams.values())
      if (stream.deviceId === deviceId) count++;
    return count;
  }

  get size() {
    return this.streams.size;
  }

  private finish(s: number) {
    const stream = this.streams.get(s);
    if (!stream) return;
    if (stream.timer) clearTimeout(stream.timer);
    this.streams.delete(s);
  }

  private idle(s: number) {
    const stream = this.streams.get(s);
    if (!stream) return;
    if (stream.timer) clearTimeout(stream.timer);
    const { limits } = this.options;
    const ms = stream.kind === "http" ? limits.httpIdleMs : limits.wsIdleMs;
    stream.timer = setTimeout(() => {
      const current = this.streams.get(s);
      if (!current) return;
      this.control({ t: "cancel", s });
      if (current.kind === "http") {
        current.fail(504);
        try {
          current.controller?.error(new Error("idle"));
        } catch {}
      } else {
        current.accept?.(null);
        current.phone?.close(1001, "idle");
      }
      this.finish(s);
    }, ms);
  }

  /** Ends the streams `which` picks: all of them when the desktop went, a removed device's otherwise. */
  drop(which: (deviceId: string) => boolean = () => true) {
    for (const [s, stream] of this.streams) {
      if (!which(stream.deviceId)) continue;
      if (stream.kind === "http") {
        stream.fail(503);
        try {
          stream.controller?.error(new Error("gone"));
        } catch {}
      } else {
        stream.accept?.(null);
        stream.phone?.close(1012, "gone");
      }
      this.finish(s);
    }
  }

  /** A phone's HTTP request, answered by the desktop. */
  async forwardHttp(
    request: Request,
    route: DeviceRoute,
    token: string,
  ): Promise<Response> {
    const { limits, secure } = this.options;
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > limits.maxRequestBytes)
      return json({ error: "That is too large to send." }, 413);
    const url = new URL(request.url);
    const s = this.streamId();
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
    const streams = this.streams;
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
          cancel: () => {
            if (streams.get(s) === stream) {
              this.control({ t: "cancel", s });
              this.finish(s);
            }
          },
        });
        resolveHead(new Response(body, { status, headers: out }));
      },
    };
    streams.set(s, stream);
    request.signal?.addEventListener("abort", () => {
      if (streams.get(s) !== stream) return;
      this.control({ t: "cancel", s });
      this.finish(s);
    });
    const headTimer = setTimeout(() => {
      if (streams.get(s) !== stream || stream.controller) return;
      stream.fail(504);
    }, limits.headTimeoutMs);
    void answered.finally(() => clearTimeout(headTimer));

    this.control({
      t: "req",
      s,
      method: request.method,
      path: url.pathname + url.search,
      headers: forwardableRequestHeaders(request.headers),
      device: { id: route.id, token },
      body: hasBody,
    });
    this.idle(s);

    if (hasBody && request.body) {
      let total = 0;
      try {
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value as Uint8Array;
          total += chunk.byteLength;
          if (total > limits.maxRequestBytes) {
            this.control({ t: "cancel", s });
            this.finish(s);
            return json({ error: "That is too large to send." }, 413);
          }
          for (let at = 0; at < chunk.byteLength; at += limits.maxChunkBytes) {
            if (streams.get(s) !== stream) break;
            this.options.send(
              encodeData(
                DATA_KIND.body,
                s,
                chunk.subarray(at, at + limits.maxChunkBytes),
              ),
            );
          }
          this.idle(s);
        }
      } catch {
        this.control({ t: "cancel", s });
        this.finish(s);
        return json({ error: "The request was cut off." }, 400);
      }
      if (streams.get(s) === stream) this.control({ t: "end", s });
    }
    return answered;
  }

  /**
   * Asks the desktop for a WebSocket for a phone. Resolves with the stream id and the protocol the
   * desktop chose once it has opened its own, or null; the platform then upgrades the phone and calls
   * {@link attachPhone}, or {@link abandon} if it could not.
   */
  async openSocket(
    request: Request,
    route: DeviceRoute,
    token: string,
  ): Promise<{ s: number; protocol: string } | null> {
    const url = new URL(request.url);
    const s = this.streamId();
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
      this.streams.set(s, stream);
      stream.timer = setTimeout(() => {
        stream.accept?.(null);
      }, this.options.limits.headTimeoutMs);
    });
    this.control({
      t: "req",
      s,
      method: "GET",
      path: url.pathname + url.search,
      headers: forwardableRequestHeaders(request.headers),
      device: { id: route.id, token },
      ws: { protocols },
      body: false,
    });
    const protocol = await accepted;
    if (protocol === null || !this.streams.has(s)) {
      this.abandon(s);
      return null;
    }
    return { s, protocol };
  }

  /** The platform upgraded the phone for stream `s`. */
  attachPhone(s: number, phone: PhoneSocket) {
    const stream = this.streams.get(s);
    if (stream?.kind !== "ws") {
      phone.close(1011, "gone");
      return;
    }
    stream.phone = phone;
    this.idle(s);
  }

  /**
   * A phone socket that outlived this object's memory (a Durable Object woke from hibernation with
   * it still open): taken back as stream `s`.
   */
  adoptPhone(s: number, deviceId: string, phone: PhoneSocket) {
    this.streams.set(s, { kind: "ws", deviceId, phone });
    if (s >= this.next) this.next = s + 1;
    this.idle(s);
  }

  /** The phone could not be upgraded after all. */
  abandon(s: number) {
    this.finish(s);
    this.control({ t: "cancel", s });
  }

  /** A message from a phone's socket. False: the stream is gone or the message too large; close it. */
  fromPhone(s: number, raw: string | Uint8Array): boolean | "too-large" {
    if (!this.streams.has(s)) return false;
    const bytes = typeof raw === "string" ? encoder.encode(raw) : raw;
    if (bytes.byteLength > this.options.limits.maxWsMessageBytes)
      return "too-large";
    this.options.send(
      encodeData(
        typeof raw === "string" ? DATA_KIND.wsText : DATA_KIND.wsBinary,
        s,
        bytes,
      ),
    );
    this.idle(s);
    return true;
  }

  /** The phone closed its socket. */
  phoneClosed(s: number, code: number, reason: string) {
    if (!this.streams.has(s)) return;
    this.control({
      t: "ws.close",
      s,
      code:
        code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
          ? code
          : 1000,
      reason: (reason ?? "").slice(0, 123),
    });
    this.finish(s);
  }

  /** A stream frame from the desktop. False: not one of these, for the caller to handle. */
  onDeskMessage(message: DeskMessage): boolean {
    switch (message.t) {
      case "res": {
        const stream = this.streams.get(message.s);
        if (stream?.kind === "http") {
          stream.head({ status: message.status, headers: message.headers });
          this.idle(message.s);
        }
        return true;
      }
      case "end": {
        const stream = this.streams.get(message.s);
        if (stream?.kind === "http") {
          try {
            stream.controller?.close();
          } catch {}
          this.finish(message.s);
        }
        return true;
      }
      case "ws.accept": {
        const stream = this.streams.get(message.s);
        if (stream?.kind === "ws") {
          if (stream.timer) clearTimeout(stream.timer);
          stream.accept?.(message.protocol);
        }
        return true;
      }
      case "ws.close": {
        const stream = this.streams.get(message.s);
        if (stream?.kind === "ws") {
          stream.accept?.(null);
          stream.phone?.close(
            message.code >= 3000 || message.code === 1000 ? message.code : 1011,
            message.reason,
          );
          this.finish(message.s);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** A binary data frame from the desktop. */
  onDeskData(raw: Uint8Array) {
    const frame = decodeData(raw);
    if (!frame) return;
    const stream = this.streams.get(frame.stream);
    if (!stream) return;
    if (stream.kind === "http") {
      if (frame.kind !== DATA_KIND.body || stream.nullBody) return;
      stream.bytes += frame.payload.byteLength;
      if (stream.bytes > this.options.limits.maxResponseBytes) {
        this.control({ t: "cancel", s: frame.stream });
        try {
          stream.controller?.error(new Error("too large"));
        } catch {}
        this.finish(frame.stream);
        return;
      }
      try {
        stream.controller?.enqueue(frame.payload.slice());
      } catch {
        this.control({ t: "cancel", s: frame.stream });
        this.finish(frame.stream);
        return;
      }
      this.idle(frame.stream);
      return;
    }
    if (!stream.phone) return;
    if (frame.kind === DATA_KIND.wsText)
      stream.phone.send(new TextDecoder().decode(frame.payload));
    else if (frame.kind === DATA_KIND.wsBinary)
      stream.phone.send(frame.payload.slice());
    this.idle(frame.stream);
  }
}
