/**
 * The few Cloudflare Workers and Durable Objects types the Workers phone relay uses, written here so
 * the repository takes no `@cloudflare/workers-types` or `wrangler` (new dependencies need Amgad's
 * yes). Only what is called is declared, with the shapes Cloudflare documents. Adapted from the Ark
 * Link relay's `worker/types.ts` (#149).
 */

/** A WebSocket as the Workers runtime has it, with the Hibernation API's attachment. */
export type CfWebSocket = {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  accept?(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readyState?: number;
};

export type SqlCursor<T> = {
  toArray(): T[];
};

export type SqlStorage = {
  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursor<T>;
};

export type DurableObjectState = {
  /** Hibernation API: the runtime keeps the socket open while the object sleeps. */
  acceptWebSocket(socket: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  /** A request text answered with a response text without waking the object. */
  setWebSocketAutoResponse(pair?: unknown): void;
  storage: {
    sql: SqlStorage;
    setAlarm(at: number): Promise<void> | void;
    getAlarm(): Promise<number | null> | number | null;
    deleteAlarm(): Promise<void> | void;
  };
};

export type DurableObjectId = unknown;

export type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

/** `connect()` from `cloudflare:sockets`. */
export type Connect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: "off" | "on" | "starttls" },
) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
};

/**
 * What differs between the Workers runtime and the stand-ins the tests use: making a socket pair, the
 * auto-response pair, the 101 answer that hands the client end back, the outside world (`fetch`), the
 * mail server's TCP socket, the clock and the log.
 */
export type Platform = {
  socketPair(): { client: CfWebSocket; server: CfWebSocket };
  autoResponse(request: string, response: string): unknown;
  upgraded(client: CfWebSocket): Response;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  connect?: Connect;
  log(line: string): void;
  /** A minute, its margin and the low-balance re-ask, shorter in tests. */
  timing?: {
    minuteMs?: number;
    marginMs?: number;
    refreshMs?: number;
    retryMs?: number;
  };
};

export type Env = {
  LINE: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  /** Exactly the address Twilio is given, e.g. `https://blackark-phone.blackark.workers.dev`. */
  PUBLIC_BASE_URL: string;
  TWILIO_ACCOUNT_SID: string;
  /** Secret. */
  TWILIO_AUTH_TOKEN: string;
  /** `https://blackark.uk/checkin/phone/`. Empty: no line is billed. */
  BILLING_URL?: string;
  /** Secret: the same as `relay_secret` in blackark.uk's `config.php`. Unset: no line is billed. */
  RELAY_SECRET?: string;
  /** Secret: what `cli.ts` presents for `/admin/*`. Unset: no admin. */
  ADMIN_TOKEN?: string;
  ALERT_SMTP_HOST?: string;
  ALERT_SMTP_PORT?: string;
  ALERT_SMTP_USER?: string;
  ALERT_FROM?: string;
  /** BlackArk's own addresses, comma-separated. */
  ALERT_TO?: string;
  /** Secret: the alert mailbox's password. Unset: the alert is only recorded and logged. */
  ALERT_SMTP_PASSWORD?: string;
};

/** The real runtime's globals, reached only when running on Workers. */
declare const WebSocketPair: {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
};
declare const WebSocketRequestResponsePair: {
  new (request: string, response: string): unknown;
};

/** The Workers runtime. `fetch` is wrapped: called unbound off an object, it throws on Workers. */
export function workersPlatform(connect?: Connect): Platform {
  return {
    socketPair() {
      const pair = new WebSocketPair();
      return { client: pair[0], server: pair[1] };
    },
    autoResponse: (request, response) =>
      new WebSocketRequestResponsePair(request, response),
    upgraded: (client) =>
      new Response(null, { status: 101, webSocket: client } as never),
    fetch: (input, init) => fetch(input, init),
    connect,
    log: (line) => console.log(line),
  };
}
