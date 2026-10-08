import { timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hub } from "./hub";
import {
  bearerFromProtocols,
  decodeFrame,
  pushFrame,
  replyFrame,
} from "./phoenix";
import { isTerminalEvent, type StoredEvent } from "./store";
import { joinCodeFor, type JoinScope, verifyJoinToken } from "./tokens";

/** Capabilities offered to a runner when it joins. */
const RUNNER_CAPABILITIES = ["runner_event_batch_v1"];

interface Join {
  joinRef: string | null;
  dispose: () => void;
  /** Set for a runner's ingestion channel. */
  ingest?: { threadId: string; runId: string; userId: string };
  /** Set for a browser's conversation channel. */
  threadId?: string;
}

export interface SocketData {
  endpoint: "runner" | "client";
  scope: JoinScope | null;
  joins: Map<string, Join>;
  /** Messages are handled one at a time so events are stored and acknowledged in order. */
  queue: Promise<void>;
}

type Socket = ServerWebSocket<SocketData>;

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const str = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

/** The realtime half of the hub: sockets for the runner and for browsers. */
export function createGateway(hub: Hub) {
  const { store, bus, config } = hub;

  /**
   * Upgrades a request to a socket, refuses it, or returns null when it is not a socket request at
   * all. A socket is authenticated before it opens, so nothing unauthenticated ever holds one.
   */
  function upgrade(
    request: Request,
    server: Server<SocketData>,
  ): Response | undefined | null {
    const url = new URL(request.url);
    const endpoint =
      url.pathname === "/runner/websocket"
        ? "runner"
        : url.pathname === "/client/websocket"
          ? "client"
          : null;
    if (!endpoint) return null;

    const offered = request.headers.get("sec-websocket-protocol");
    let scope: JoinScope | null = null;
    if (endpoint === "runner") {
      const token = bearerFromProtocols(offered);
      if (!token || !safeEqual(token, config.apiKey)) {
        return new Response("unauthorized", { status: 401 });
      }
    } else {
      const token = url.searchParams.get("join_token");
      scope = token ? verifyJoinToken(config.joinSecret, token) : null;
      if (!scope) return new Response("unauthorized", { status: 401 });
    }

    const speaksPhoenix = (offered ?? "")
      .split(",")
      .some((part) => part.trim() === "phoenix");
    const ok = server.upgrade(request, {
      data: {
        endpoint,
        scope,
        joins: new Map(),
        queue: Promise.resolve(),
      } satisfies SocketData,
      // A subprotocol may only be selected if the client offered it.
      ...(speaksPhoenix
        ? { headers: { "Sec-WebSocket-Protocol": "phoenix" } }
        : {}),
    });
    return ok ? undefined : new Response("upgrade failed", { status: 400 });
  }

  // ---- runner: ingestion ---------------------------------------------------

  async function joinIngestion(
    ws: Socket,
    topic: string,
    joinRef: string | null,
    ref: string | null,
    payload: unknown,
  ) {
    const params = record(payload);
    const runId = str(params.run_id) ?? topic.slice("ingestion:".length);
    const threadId = str(params.thread_id);
    const lock = threadId ? await store.activeLock(threadId) : null;
    if (!threadId || !lock || lock.runId !== runId) {
      ws.send(
        replyFrame(joinRef, ref, topic, "error", {
          reason: "active_lock_mismatch",
          retryable: false,
        }),
      );
      return;
    }
    // A stop request from the browser is relayed to the runner as an event it already understands.
    const dispose = bus.subscribe(`runner:${runId}`, (event, body) => {
      ws.send(pushFrame(topic, event, body));
    });
    ws.data.joins.get(topic)?.dispose();
    ws.data.joins.set(topic, {
      joinRef,
      dispose,
      ingest: { threadId, runId, userId: lock.userId },
    });
    ws.send(
      replyFrame(joinRef, ref, topic, "ok", {
        capabilities: RUNNER_CAPABILITIES,
      }),
    );
  }

  async function ingest(
    ws: Socket,
    join: Join,
    topic: string,
    ref: string | null,
    events: Array<Record<string, unknown> & { type?: string }>,
  ) {
    const target = join.ingest;
    if (!target) return;
    let stored: StoredEvent[];
    try {
      stored = await store.appendEvents(target.threadId, target.runId, events);
    } catch (error) {
      console.error("hub could not store events", error);
      ws.send(
        replyFrame(join.joinRef, ref, topic, "error", {
          reason: "storage_error",
          retryable: true,
        }),
      );
      return;
    }
    // Acknowledged only now that the events are durable: the runner resends anything unacknowledged.
    ws.send(replyFrame(join.joinRef, ref, topic, "ok", {}));

    const thread =
      stored.length > 0
        ? await store.getThread(target.threadId, target.userId)
        : null;
    for (const event of stored) {
      bus.publish(`thread:${target.threadId}`, "stored", event);
      if (!thread) continue;
      if (event.payload.type === "RUN_STARTED") {
        hub.announceThread("updated", thread);
        hub.announceRunActivity(thread, target.runId, event);
      } else if (isTerminalEvent(event.payload)) {
        await store.releaseLock(target.threadId, target.runId);
        hub.announceRunActivity(thread, target.runId, event);
        bus.publish(`thread:${target.threadId}`, "idle", {
          latest_event_id: event.eventId,
        });
      }
    }
  }

  // ---- browser: conversation and thread-list channels ----------------------

  async function joinThread(
    ws: Socket,
    topic: string,
    joinRef: string | null,
    ref: string | null,
    payload: unknown,
  ) {
    const threadId = topic.slice("thread:".length);
    const scope = ws.data.scope;
    if (scope?.kind !== "thread" || scope.threadId !== threadId) {
      ws.send(
        replyFrame(joinRef, ref, topic, "error", { reason: "unauthorized" }),
      );
      return;
    }
    const params = record(payload);
    const mode = params.stream_mode === "run" ? "run" : "connect";
    const runId = str(params.run_id);
    const afterEventId = str(params.last_seen_event_id);

    // Listen first and hold what arrives, so nothing stored while the replay is read is missed.
    const buffered: StoredEvent[] = [];
    let live = false;
    let lastSeq = 0;
    const send = (event: StoredEvent) => {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      ws.send(pushFrame(topic, "ag_ui_event", event.payload));
    };
    const dispose = bus.subscribe(topic, (event, body) => {
      if (event === "stored") {
        if (live) send(body as StoredEvent);
        else buffered.push(body as StoredEvent);
      } else if (event === "idle" && live) {
        ws.send(pushFrame(topic, "stream_idle", body));
      }
    });
    ws.data.joins.get(topic)?.dispose();
    ws.data.joins.set(topic, { joinRef, dispose, threadId });
    ws.send(replyFrame(joinRef, ref, topic, "ok", {}));

    const replay = await store.eventsForReplay(threadId, {
      ...(mode === "run" && runId ? { runId } : {}),
      ...(mode === "connect" && afterEventId ? { afterEventId } : {}),
    });
    for (const event of replay) send(event);
    for (const event of buffered) send(event);
    live = true;

    const latest =
      (await store.latestEventId(threadId)) ?? afterEventId ?? null;
    ws.send(pushFrame(topic, "replay_complete", { latest_event_id: latest }));
    if (mode === "connect" && !(await store.activeLock(threadId))) {
      ws.send(pushFrame(topic, "stream_idle", { latest_event_id: latest }));
    }
  }

  async function joinMeta(
    ws: Socket,
    topic: string,
    joinRef: string | null,
    ref: string | null,
  ) {
    const scope = ws.data.scope;
    const code = topic.slice("user_meta:".length);
    if (
      scope?.kind !== "meta" ||
      code !== joinCodeFor(config.joinSecret, scope.userId)
    ) {
      ws.send(
        replyFrame(joinRef, ref, topic, "error", { reason: "unauthorized" }),
      );
      return;
    }
    const dispose = bus.subscribe(topic, (event, body) => {
      ws.send(pushFrame(topic, event, body));
    });
    ws.data.joins.get(topic)?.dispose();
    ws.data.joins.set(topic, { joinRef, dispose });
    ws.send(replyFrame(joinRef, ref, topic, "ok", {}));
  }

  // ---- dispatch ------------------------------------------------------------

  async function handle(ws: Socket, raw: string | Buffer) {
    const frame = decodeFrame(raw);
    if (!frame) return;
    const [joinRef, ref, topic, event, payload] = frame;

    if (event === "heartbeat" && topic === "phoenix") {
      ws.send(replyFrame(null, ref, "phoenix", "ok", {}));
      return;
    }
    if (event === "phx_join") {
      const { endpoint } = ws.data;
      if (endpoint === "runner" && topic.startsWith("ingestion:")) {
        await joinIngestion(ws, topic, joinRef, ref, payload);
      } else if (endpoint === "client" && topic.startsWith("thread:")) {
        await joinThread(ws, topic, joinRef, ref, payload);
      } else if (endpoint === "client" && topic.startsWith("user_meta:")) {
        await joinMeta(ws, topic, joinRef, ref);
      } else {
        ws.send(
          replyFrame(joinRef, ref, topic, "error", { reason: "unknown_topic" }),
        );
      }
      return;
    }
    if (event === "phx_leave") {
      ws.data.joins.get(topic)?.dispose();
      ws.data.joins.delete(topic);
      ws.send(replyFrame(joinRef, ref, topic, "ok", {}));
      return;
    }

    const join = ws.data.joins.get(topic);
    if (!join) {
      ws.send(
        replyFrame(joinRef, ref, topic, "error", { reason: "not_joined" }),
      );
      return;
    }

    if (join.ingest && (event === "event" || event === "events")) {
      const body = record(payload);
      const events = (
        event === "events" ? (body.events as unknown[]) : [payload]
      ).filter(
        (item): item is Record<string, unknown> & { type?: string } =>
          !!item && typeof item === "object",
      );
      await ingest(ws, join, topic, ref, events);
      return;
    }

    if (join.threadId && event === "stop_run") {
      const runId = str(record(payload).run_id);
      if (runId && (await store.holdsLock(join.threadId, runId))) {
        bus.publish(`runner:${runId}`, "ag-ui", {
          type: "CUSTOM",
          name: "stop",
          value: { run_id: runId },
        });
        ws.send(replyFrame(joinRef, ref, topic, "ok", {}));
      } else {
        ws.send(
          replyFrame(joinRef, ref, topic, "error", { reason: "no_active_run" }),
        );
      }
      return;
    }

    ws.send(
      replyFrame(joinRef, ref, topic, "error", { reason: "unknown_event" }),
    );
  }

  const websocket: WebSocketHandler<SocketData> = {
    // The SDK's clients send a heartbeat every 30 seconds; give a stalled socket a generous margin.
    idleTimeout: 120,
    message(ws, raw) {
      ws.data.queue = ws.data.queue
        .then(() => handle(ws, raw))
        .catch((error) => {
          console.error("hub socket handler failed", error);
        });
    },
    close(ws) {
      for (const join of ws.data.joins.values()) join.dispose();
      ws.data.joins.clear();
    },
  };

  return { upgrade, websocket };
}
