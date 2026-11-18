/**
 * Stand-ins for the Workers runtime, so the Workers relay runs under `bun test` (#149): Durable Object
 * namespaces and state with SQLite (`bun:sqlite`), the Hibernation API's accepted sockets with tags,
 * attachments and auto-response, socket pairs, and eviction (an object dropped from memory while its
 * sockets stay open, as hibernation does). Test code only; nothing here ships.
 */
import { Database } from "bun:sqlite";
import type {
  CfWebSocket,
  DurableObjectState,
  DurableObjectStub,
  Env,
  Platform,
} from "./types";

type Handlers = {
  fetch(request: Request): Promise<Response>;
  webSocketMessage?(socket: CfWebSocket, raw: string | ArrayBuffer): unknown;
  webSocketClose?(socket: CfWebSocket, code: number, reason: string): unknown;
  alarm?(): unknown;
};

/** One end of a socket pair. The server end is accepted into an object; the client end is the caller's. */
export class FakeSocket implements CfWebSocket {
  peer!: FakeSocket;
  readyState = 1;
  received: (string | Uint8Array)[] = [];
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  /** Set on a server end once an object accepted it. */
  owner: FakeState | null = null;
  private attachment: unknown = null;

  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return;
    const copy =
      typeof data === "string"
        ? data
        : new Uint8Array(data instanceof Uint8Array ? data : data).slice();
    queueMicrotask(() => this.peer.deliver(copy));
  }

  private deliver(data: string | Uint8Array) {
    if (this.readyState !== 1) return;
    if (this.owner) {
      // Auto-response: answered by the runtime, the object is not woken.
      if (typeof data === "string" && this.owner.autoResponds(data)) {
        this.owner.autoResponses++;
        this.send(this.owner.autoResponse?.response ?? "");
        return;
      }
      this.owner.messages++;
      const raw =
        typeof data === "string"
          ? data
          : data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            );
      void this.owner.handlers().webSocketMessage?.(this, raw as ArrayBuffer);
      return;
    }
    this.received.push(data);
    this.onmessage?.(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => this.peer.closedByPeer(code, reason));
    this.owner?.forget(this);
  }

  private closedByPeer(code: number, reason: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    if (this.owner) {
      this.owner.forget(this);
      void this.owner.handlers().webSocketClose?.(this, code, reason);
    } else this.onclose?.(code, reason);
  }

  accept() {}
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

export function socketPair() {
  const client = new FakeSocket();
  const server = new FakeSocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

export class FakeState implements DurableObjectState {
  private sockets: { socket: FakeSocket; tags: string[] }[] = [];
  autoResponse: { request: string; response: string } | null = null;
  autoResponses = 0;
  /** Messages that woke the object: what Cloudflare bills at 20 to 1. */
  messages = 0;
  alarmAt: number | null = null;
  private db = new Database(":memory:");

  constructor(public handlers: () => Handlers) {}

  storage = {
    sql: {
      exec: <T>(query: string, ...bindings: unknown[]) => {
        const rows = this.db.query(query).all(...(bindings as never[])) as T[];
        return { toArray: () => rows };
      },
    },
    setAlarm: (at: number) => {
      this.alarmAt = at;
    },
    getAlarm: () => this.alarmAt,
  };

  acceptWebSocket(socket: CfWebSocket, tags: string[] = []) {
    const fake = socket as FakeSocket;
    fake.owner = this;
    this.sockets.push({ socket: fake, tags });
  }
  getWebSockets(tag?: string) {
    return this.sockets
      .filter((entry) => !tag || entry.tags.includes(tag))
      .map((entry) => entry.socket);
  }
  getTags(socket: CfWebSocket) {
    return this.sockets.find((entry) => entry.socket === socket)?.tags ?? [];
  }
  setWebSocketAutoResponse(pair?: unknown) {
    this.autoResponse = (pair as { request: string; response: string }) ?? null;
  }
  autoResponds(data: string) {
    return this.autoResponse?.request === data;
  }
  forget(socket: FakeSocket) {
    this.sockets = this.sockets.filter((entry) => entry.socket !== socket);
  }
}

/** A namespace whose objects are made on first use, and can be evicted (hibernation) by name. */
export class FakeNamespace {
  private states = new Map<string, FakeState>();
  private objects = new Map<string, Handlers>();
  constructor(private make: (state: FakeState) => Handlers) {}
  idFromName(name: string) {
    return name;
  }
  state(name: string): FakeState {
    let state = this.states.get(name);
    if (!state) {
      state = new FakeState(() => this.object(name));
      this.states.set(name, state);
    }
    return state;
  }
  object(name: string): Handlers {
    let object = this.objects.get(name);
    if (!object) {
      object = this.make(this.state(name));
      this.objects.set(name, object);
    }
    return object;
  }
  get(id: unknown): DurableObjectStub {
    const name = id as string;
    return { fetch: (request) => this.object(name).fetch(request) };
  }
  /** Drops the object from memory; its state and accepted sockets stay, as in hibernation. */
  evict(name: string) {
    this.objects.delete(name);
  }
}

const upgradedSockets = new WeakMap<Response, FakeSocket>();

export const standInPlatform: Platform = {
  socketPair,
  autoResponse: (request, response) => ({ request, response }),
  upgraded(client, headers) {
    const response = new Response(null, {
      status: 200,
      headers: { "x-stand-in-upgrade": "1", ...(headers as object) },
    });
    upgradedSockets.set(response, client as FakeSocket);
    return response;
  },
};

/** The client end of a socket the relay handed back, or undefined when it answered without one. */
export function upgradedSocket(response: Response): FakeSocket | undefined {
  return upgradedSockets.get(response);
}

export type StandInEnv = Env & {
  INSTALL: FakeNamespace;
  DIRECTORY: FakeNamespace;
};
