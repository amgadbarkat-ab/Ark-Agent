/**
 * The few Cloudflare Workers and Durable Objects types the Workers relay uses, written here so the
 * repository takes no `@cloudflare/workers-types` or `wrangler` (new dependencies need Amgad's yes).
 * Only what is called is declared, with the shapes Cloudflare documents.
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
  getTags(socket: CfWebSocket): string[];
  /** A request text answered with a response text without waking the object. */
  setWebSocketAutoResponse(pair?: unknown): void;
  storage: {
    sql: SqlStorage;
    setAlarm(at: number): Promise<void> | void;
    getAlarm(): Promise<number | null> | number | null;
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

/**
 * What differs between the Workers runtime and the stand-ins the tests use: making a socket pair, the
 * auto-response pair, and the 101 answer that hands the client end back.
 */
export type Platform = {
  socketPair(): { client: CfWebSocket; server: CfWebSocket };
  autoResponse(request: string, response: string): unknown;
  upgraded(client: CfWebSocket, headers?: HeadersInit): Response;
};

export type Env = {
  INSTALL: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  /** `https://link.blackark.uk`. */
  LINK_ORIGIN: string;
  /** `[{"id":"demo-shop","tokenSha256":"…"}]`: hashes only, so a plain variable. */
  LINK_INSTALLS: string;
  ARK_ANDROID_APP_ID?: string;
  ARK_ANDROID_CERT_SHA256?: string;
  ARK_IOS_APP_ID?: string;
};

/** The real runtime's globals, reached only when running on Workers. */
declare const WebSocketPair: {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
};
declare const WebSocketRequestResponsePair: {
  new (request: string, response: string): unknown;
};

export const workersPlatform: Platform = {
  socketPair() {
    const pair = new WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  autoResponse: (request, response) =>
    new WebSocketRequestResponsePair(request, response),
  upgraded: (client, headers) =>
    new Response(null, { status: 101, webSocket: client, headers } as never),
};
