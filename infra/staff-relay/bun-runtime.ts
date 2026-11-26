/**
 * The staff relay on Bun, with real WebSockets: the Worker and its office objects over a small
 * stand-in for the Workers runtime (Hibernation API sockets with tags and attachments, the ping
 * auto-response, SQLite storage, alarms). For the tests, so the company's computer and a staff
 * computer can be joined through the very code that runs on Cloudflare. Nothing here ships.
 */
import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import type {
  CfWebSocket,
  DurableObjectState,
} from "../phone-relay/worker/types";
import {
  createWorker,
  type Env,
  OfficeObject,
  type RelayPlatform,
} from "./relay";

type Bound = ServerWebSocket<{ socket: BunSocket }>;

/** The server end of a socket the relay accepted or refused, bound to Bun's socket once it opens. */
class BunSocket implements CfWebSocket {
  readyState = 1;
  owner: StandInState | null = null;
  closedHere = false;
  private ws: Bound | null = null;
  private pending: (() => void)[] = [];
  private attachment: unknown = null;

  bind(ws: Bound) {
    this.ws = ws;
    for (const run of this.pending.splice(0)) run();
  }
  private when(run: () => void) {
    if (this.ws) run();
    else this.pending.push(run);
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return;
    this.when(() => this.ws?.send(data as string | ArrayBuffer));
  }
  close(code = 1000, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedHere = true;
    this.owner?.forget(this);
    this.when(() => this.ws?.close(code, reason));
  }
  accept() {}
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

class StandInState implements DurableObjectState {
  private sockets: { socket: BunSocket; tags: string[] }[] = [];
  autoResponse: { request: string; response: string } | null = null;
  /** Messages that woke the object. */
  woke = 0;
  private alarmAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private db = new Database(":memory:");

  constructor(readonly object: () => OfficeObject) {}

  storage = {
    sql: {
      exec: <T>(query: string, ...bindings: unknown[]) => {
        const rows = this.db.query(query).all(...(bindings as never[])) as T[];
        return { toArray: () => rows };
      },
    },
    setAlarm: (at: number) => {
      this.stopAlarm();
      this.alarmAt = at;
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.alarmAt = null;
          void this.object().alarm();
        },
        // setTimeout fires at once beyond about 24.8 days; the tests run far alarms by hand.
        Math.min(2_147_483_647, Math.max(0, at - Date.now())),
      );
    },
    getAlarm: () => this.alarmAt,
    deleteAlarm: () => {
      this.stopAlarm();
      this.alarmAt = null;
    },
  };

  stopAlarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  acceptWebSocket(socket: CfWebSocket, tags: string[] = []) {
    const bun = socket as BunSocket;
    bun.owner = this;
    this.sockets.push({ socket: bun, tags });
  }
  getWebSockets(tag?: string) {
    return this.sockets
      .filter((entry) => !tag || entry.tags.includes(tag))
      .map((entry) => entry.socket);
  }
  setWebSocketAutoResponse(pair?: unknown) {
    this.autoResponse = (pair as { request: string; response: string }) ?? null;
  }
  forget(socket: BunSocket) {
    this.sockets = this.sockets.filter((entry) => entry.socket !== socket);
  }
}

/** Starts the relay on a loopback port. `keys` are the BlackArk public keys it trusts. */
export function startBunRelay(options: {
  keys: { license: readonly string[]; trial: readonly string[] };
  now?: () => number;
  log?: (line: string) => void;
  pairingMs?: number;
  revoked?: string;
}) {
  const handed = new WeakMap<Response, BunSocket>();
  const platform: RelayPlatform = {
    socketPair() {
      const server = new BunSocket();
      return { client: server, server };
    },
    autoResponse: (request, response) => ({ request, response }),
    upgraded(client) {
      const response = new Response(null, { status: 200 });
      handed.set(response, client as BunSocket);
      return response;
    },
    log: options.log ?? (() => {}),
    keys: options.keys,
    ...(options.now ? { now: options.now } : {}),
    ...(options.pairingMs ? { pairingMs: options.pairingMs } : {}),
  };
  const states = new Map<string, StandInState>();
  const objects = new Map<string, OfficeObject>();
  const object = (name: string): OfficeObject => {
    let found = objects.get(name);
    if (!found) {
      let state = states.get(name);
      if (!state) {
        state = new StandInState(() => object(name));
        states.set(name, state);
      }
      found = new OfficeObject(state, env, platform);
      objects.set(name, found);
    }
    return found;
  };
  const env: Env = {
    ...(options.revoked ? { REVOKED_CUSTOMERS: options.revoked } : {}),
    OFFICE: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (request: Request) => object(id as string).fetch(request),
      }),
    },
  };
  const worker = createWorker(platform);

  const server = Bun.serve<{ socket: BunSocket }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bunServer) {
      const response = await worker.fetch(request, env);
      const socket = handed.get(response);
      if (!socket) return response;
      if (bunServer.upgrade(request, { data: { socket } }))
        return undefined as unknown as Response;
      return new Response("Expected a WebSocket.", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.data.socket.bind(ws);
      },
      message(ws, message) {
        const socket = ws.data.socket;
        const state = socket.owner;
        if (!state || socket.readyState !== 1) return;
        if (typeof message === "string") {
          // Answered by the runtime, without waking the object, as on Cloudflare.
          if (state.autoResponse?.request === message) {
            ws.send(state.autoResponse.response);
            return;
          }
          state.woke++;
          state.object().webSocketMessage(socket, message);
          return;
        }
        state.woke++;
        const bytes = new Uint8Array(message);
        state.object().webSocketMessage(socket, bytes.slice().buffer);
      },
      close(ws, code, reason) {
        const socket = ws.data.socket;
        if (socket.closedHere) return;
        socket.readyState = 3;
        const state = socket.owner;
        state?.forget(socket);
        state?.object().webSocketClose(socket, code, reason);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    /** Drops every office object from memory, as hibernation does; sockets and storage stay. */
    hibernate: () => objects.clear(),
    woke: (office: string) => states.get(`office:${office}`)?.woke ?? 0,
    /** Runs an office's alarm now, as Cloudflare does when its time comes (the clock is the test's). */
    alarm: (office: string) => object(`office:${office}`).alarm(),
    /** When the office's alarm is set for, or null. */
    alarmAt: (office: string) =>
      states.get(`office:${office}`)?.storage.getAlarm() ?? null,
    /** The offices the customer's object counts. */
    offices: (customer: string) =>
      states.has(`customer:${customer}`)
        ? (states
            .get(`customer:${customer}`)
            ?.storage.sql.exec<{ office: string }>("SELECT office FROM offices")
            .toArray()
            .map((row) => row.office) ?? [])
        : [],
    stop: () => {
      for (const state of states.values()) state.stopAlarm();
      server.stop(true);
    },
  };
}
