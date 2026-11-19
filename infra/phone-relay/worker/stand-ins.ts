/**
 * Stand-ins for the Workers runtime, so the Workers phone relay runs under `bun test`: Durable Object
 * namespaces and state with SQLite (`bun:sqlite`), the Hibernation API's accepted sockets with tags,
 * attachments and auto-response, socket pairs, alarms that fire on the clock as the runtime's do, and
 * eviction (an object dropped from memory while its sockets and storage stay, as hibernation does).
 * Adapted from the Ark Link relay's `worker/stand-ins.ts` (#149). Test code only; nothing here ships.
 */
import { Database } from "bun:sqlite";
import type {
  CfWebSocket,
  DurableObjectState,
  DurableObjectStub,
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
  received: string[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Set on a server end once an object accepted it. */
  owner: FakeState | null = null;
  private attachment: unknown = null;

  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return;
    const text =
      typeof data === "string" ? data : new TextDecoder().decode(data);
    queueMicrotask(() => this.peer.deliver(text));
  }

  /** The messages received so far, parsed. */
  messages(): Record<string, unknown>[] {
    return this.received.map((text) => JSON.parse(text));
  }

  private deliver(data: string) {
    if (this.readyState !== 1) return;
    if (this.owner) {
      // Auto-response: answered by the runtime, the object is not woken.
      if (this.owner.autoResponse?.request === data) {
        this.owner.autoResponses++;
        this.send(this.owner.autoResponse.response);
        return;
      }
      this.owner.messages++;
      void this.owner.handlers().webSocketMessage?.(this, data);
      return;
    }
    this.received.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    queueMicrotask(() => this.peer.closedByPeer(code, reason));
    this.owner?.forget(this);
  }

  private closedByPeer(code: number, reason: string) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    if (this.owner) {
      this.owner.forget(this);
      void this.owner.handlers().webSocketClose?.(this, code, reason);
    }
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
  alarms = 0;
  alarmAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
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
      this.stop();
      this.alarmAt = at;
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.alarmAt = null;
          this.alarms++;
          void this.handlers().alarm?.();
        },
        Math.max(0, at - Date.now()),
      );
    },
    getAlarm: () => this.alarmAt,
    deleteAlarm: () => {
      this.stop();
      this.alarmAt = null;
    },
  };

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

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
  setWebSocketAutoResponse(pair?: unknown) {
    this.autoResponse = (pair as { request: string; response: string }) ?? null;
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
  /** Drops the object from memory; its storage, alarm and accepted sockets stay, as in hibernation. */
  evict(name: string) {
    this.objects.delete(name);
  }
  /** Stops every alarm, at the end of a test. */
  stopAll() {
    for (const state of this.states.values()) state.stop();
  }
}

const upgradedSockets = new WeakMap<Response, FakeSocket>();

/** The stand-in runtime. `fetch` and `log` are the test's own. */
export function standInPlatform(
  options: Pick<Platform, "fetch" | "log" | "connect" | "timing">,
): Platform {
  return {
    socketPair,
    autoResponse: (request, response) => ({ request, response }),
    upgraded(client) {
      const response = new Response(null, {
        status: 200,
        headers: { "x-stand-in-upgrade": "1" },
      });
      upgradedSockets.set(response, client as FakeSocket);
      return response;
    },
    ...options,
  };
}

/** The client end of a socket the relay handed back, or undefined when it answered without one. */
export function upgradedSocket(response: Response): FakeSocket | undefined {
  return upgradedSockets.get(response);
}
