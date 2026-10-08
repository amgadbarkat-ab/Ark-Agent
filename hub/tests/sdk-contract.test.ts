/**
 * The hub against the real CopilotKit SDK.
 *
 * The SDK's Intelligence client, its runner, and its Phoenix browser client are the only
 * specification of the protocol, so these tests drive them directly instead of re-describing what
 * they do. If the hub passes, the SDK cannot tell it from the service it was written for.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { Socket } from "phoenix";
import { lastValueFrom, Observable } from "rxjs";
import type { HubConfig } from "../src/config";
import { type RunningHub, startHub } from "../src/server";
import { createTestDatabase, type TestDatabase } from "./support";

const API_KEY = "k".repeat(40);
const config: HubConfig = {
  port: 0,
  databaseUrl: "unused",
  apiKey: API_KEY,
  joinSecret: "j".repeat(40),
  joinTokenTtlSeconds: 3600,
  defaultLockTtlSeconds: 60,
  bus: "postgres",
};

let database: TestDatabase;
let running: RunningHub;
let intelligence: CopilotKitIntelligence;

beforeAll(async () => {
  database = await createTestDatabase();
  running = await startHub(config, { sql: database.sql });
  intelligence = new CopilotKitIntelligence({
    apiUrl: running.apiUrl,
    wsUrl: running.wsUrl,
    apiKey: API_KEY,
  });
});
afterAll(async () => {
  await running.stop();
  await database.drop();
});

/** An agent that replies "hello", pausing between events while `gate` is unresolved. */
class ScriptedAgent extends AbstractAgent {
  constructor(private readonly gate: Promise<void> = Promise.resolve()) {
    super();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const base = { threadId: input.threadId, runId: input.runId };
      const emit = (event: Record<string, unknown>) =>
        observer.next(event as unknown as BaseEvent);
      emit({ type: EventType.RUN_STARTED, ...base });
      emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "a1",
        role: "assistant",
      });
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "a1",
        delta: "hel",
      });
      this.gate.then(() => {
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "a1",
          delta: "lo",
        });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: "a1" });
        emit({ type: EventType.RUN_FINISHED, ...base });
        observer.complete();
      });
    });
  }
}

const runnerFor = () =>
  new IntelligenceAgentRunner({
    url: intelligence.ɵgetRunnerWsUrl(),
    authToken: intelligence.ɵgetRunnerAuthToken(),
  });

const inputFor = (threadId: string, runId: string): RunAgentInput => ({
  threadId,
  runId,
  messages: [{ id: `u-${runId}`, role: "user", content: "hi" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

interface Watch {
  events: Array<Record<string, unknown>>;
  controls: Array<{ event: string; payload: Record<string, unknown> }>;
  /** Resolves on `stream_idle` or on a terminal run event. */
  done: Promise<void>;
  socket: Socket;
  channel: ReturnType<Socket["channel"]>;
  joined: Promise<void>;
  close(): void;
}

/** Joins a conversation the way the browser does: a Phoenix socket carrying a join token. */
function watch(
  joinToken: string,
  topic: string,
  params: Record<string, unknown>,
  until: "idle" | "terminal" = "idle",
): Watch {
  const socket = new Socket(`${running.wsUrl}/client`, {
    params: { join_token: joinToken },
  });
  socket.connect();
  const channel = socket.channel(topic, params);
  const events: Watch["events"] = [];
  const controls: Watch["controls"] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  channel.on("ag_ui_event", (payload: Record<string, unknown>) => {
    events.push(payload);
    if (
      until === "terminal" &&
      (payload.type === "RUN_FINISHED" || payload.type === "RUN_ERROR")
    ) {
      finish();
    }
  });
  for (const event of ["replay_complete", "stream_idle"]) {
    channel.on(event, (payload: Record<string, unknown>) => {
      controls.push({ event, payload });
      if (until === "idle" && event === "stream_idle") finish();
    });
  }
  const joined = new Promise<void>((resolve, reject) => {
    channel
      .join()
      .receive("ok", () => resolve())
      .receive("error", (response: unknown) =>
        reject(new Error(`join refused: ${JSON.stringify(response)}`)),
      )
      .receive("timeout", () => reject(new Error("join timed out")));
  });
  return {
    events,
    controls,
    done,
    socket,
    channel,
    joined,
    close() {
      channel.leave();
      socket.disconnect();
    },
  };
}

const withTimeout = <T>(promise: Promise<T>, ms = 8000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

describe("a run through the SDK's own runner", () => {
  test("is stored, ends with the lock released, and can be read back", async () => {
    const threadId = "sdk-run-1";
    const { created } = await intelligence.getOrCreateThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    expect(created).toBe(true);

    const lock = await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });
    expect(lock.runId).toBe("run-1");
    expect(lock.joinToken).toBeTruthy();

    await withTimeout(
      lastValueFrom(
        runnerFor().run({
          threadId,
          agent: new ScriptedAgent(),
          input: inputFor(threadId, "run-1"),
        }),
        { defaultValue: undefined },
      ),
    );

    const { messages } = await intelligence.getThreadMessages({
      threadId,
      userId: "ann",
    });
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);

    // The run is over, so another can start without waiting for the lock to expire.
    const next = await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "run-2",
      userId: "ann",
      agentId: "general",
    });
    expect(next.runId).toBe("run-2");
  });

  test("a browser joining afterwards replays the whole conversation, then goes idle", async () => {
    const threadId = "sdk-replay-1";
    await intelligence.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });
    await withTimeout(
      lastValueFrom(
        runnerFor().run({
          threadId,
          agent: new ScriptedAgent(),
          input: inputFor(threadId, "run-1"),
        }),
        { defaultValue: undefined },
      ),
    );

    const connection = await intelligence.ɵconnectThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    expect(connection?.joinToken).toBeTruthy();

    const view = watch(connection?.joinToken as string, `thread:${threadId}`, {
      stream_mode: "connect",
      last_seen_event_id: null,
    });
    await withTimeout(view.joined);
    await withTimeout(view.done);
    view.close();

    expect(view.events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const names = view.controls.map((c) => c.event);
    expect(names).toEqual(["replay_complete", "stream_idle"]);
    const last = view.events[view.events.length - 1] as {
      metadata: { cpki_event_id: string };
    };
    expect(view.controls[0]?.payload.latest_event_id).toBe(
      last.metadata.cpki_event_id,
    );

    // Resuming from a cursor replays only what came after it.
    const first = view.events[2] as { metadata: { cpki_event_id: string } };
    const resumed = watch(
      connection?.joinToken as string,
      `thread:${threadId}`,
      {
        stream_mode: "connect",
        last_seen_event_id: first.metadata.cpki_event_id,
      },
    );
    await withTimeout(resumed.joined);
    await withTimeout(resumed.done);
    resumed.close();
    expect(resumed.events.map((e) => e.type)).toEqual([
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  test("a browser joined mid-run sees the rest live, with nothing missed or doubled", async () => {
    const threadId = "sdk-live-1";
    await intelligence.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    const lock = await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = lastValueFrom(
      runnerFor().run({
        threadId,
        agent: new ScriptedAgent(gate),
        input: inputFor(threadId, "run-1"),
      }),
      { defaultValue: undefined },
    );

    // Wait until the first events are stored, then join part-way through the run.
    for (let i = 0; i < 100; i++) {
      const stored = await database.sql`
        select count(*)::int as n from hub_events where thread_id = ${threadId}`;
      if ((stored[0]?.n as number) >= 3) break;
      await Bun.sleep(20);
    }
    const view = watch(
      lock.joinToken,
      `thread:${threadId}`,
      { stream_mode: "run", run_id: "run-1" },
      "terminal",
    );
    await withTimeout(view.joined);
    release();
    await withTimeout(view.done);
    await withTimeout(finished);
    view.close();

    const types = view.events.map((e) => e.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const ids = view.events.map(
      (e) => (e.metadata as { cpki_event_id: string }).cpki_event_id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("stopping a run", () => {
  test("a browser's stop request reaches the runner's agent", async () => {
    const threadId = "sdk-stop-1";
    await intelligence.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    const lock = await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });

    let aborted!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    class StoppableAgent extends ScriptedAgent {
      override abortRun() {
        aborted();
        super.abortRun();
      }
    }
    // The gate never opens: the run stays in progress until it is told to stop.
    const agent = new StoppableAgent(new Promise<void>(() => {}));
    const finished = lastValueFrom(
      runnerFor().run({ threadId, agent, input: inputFor(threadId, "run-1") }),
      { defaultValue: undefined },
    ).catch(() => undefined);

    const view = watch(
      lock.joinToken,
      `thread:${threadId}`,
      { stream_mode: "run", run_id: "run-1" },
      "terminal",
    );
    await withTimeout(view.joined);
    for (let i = 0; i < 100 && view.events.length < 3; i++) await Bun.sleep(20);

    const reply = await new Promise<string>((resolve) => {
      view.channel
        .push("stop_run", { run_id: "run-1" })
        .receive("ok", () => resolve("ok"))
        .receive("error", () => resolve("error"));
    });
    expect(reply).toBe("ok");
    await withTimeout(abortSeen);
    view.close();
    void finished;

    // A stop for a run that is not the active one is declined.
    const late = watch(
      lock.joinToken,
      `thread:${threadId}`,
      { stream_mode: "connect" },
      "idle",
    );
    await withTimeout(late.joined);
    const declined = await new Promise<string>((resolve) => {
      late.channel
        .push("stop_run", { run_id: "some-other-run" })
        .receive("ok", () => resolve("ok"))
        .receive("error", () => resolve("error"));
    });
    late.close();
    expect(declined).toBe("error");
  });
});

describe("locks and access", () => {
  test("a second run is refused while the first holds the conversation", async () => {
    const threadId = "sdk-lock-1";
    await intelligence.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "first",
      userId: "ann",
      agentId: "general",
    });
    const refusal = await intelligence
      .ɵacquireThreadLock({
        threadId,
        runId: "second",
        userId: "ann",
        agentId: "general",
      })
      .catch((error: unknown) => error);
    expect((refusal as { status?: number }).status).toBe(409);

    await intelligence.ɵrenewThreadLock({
      threadId,
      runId: "first",
      ttlSeconds: 30,
    });
    await intelligence.ɵcleanupThreadLock({ threadId, runId: "first" });
    await intelligence.ɵacquireThreadLock({
      threadId,
      runId: "second",
      userId: "ann",
      agentId: "general",
    });
  });

  test("the runner is refused without the right key, and a run needs its lock", async () => {
    const unauthorized = await fetch(`${running.apiUrl}/runner/websocket`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(unauthorized.status).toBe(401);
    const badJoin = await fetch(
      `${running.apiUrl}/client/websocket?join_token=forged`,
      {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      },
    );
    expect(badJoin.status).toBe(401);

    // A runner that never took the lock cannot write to the conversation.
    await intelligence.createThread({
      threadId: "sdk-nolock",
      userId: "ann",
      agentId: "general",
    });
    const events = await withTimeout(
      lastValueFrom(
        runnerFor()
          .run({
            threadId: "sdk-nolock",
            agent: new ScriptedAgent(),
            input: inputFor("sdk-nolock", "rogue"),
          })
          .pipe((source) => source),
        { defaultValue: undefined },
      ).then(
        () => "completed",
        () => "failed",
      ),
    );
    const stored = await database.sql`
      select count(*)::int as n from hub_events where thread_id = 'sdk-nolock'`;
    expect(stored[0]?.n).toBe(0);
    expect(["completed", "failed"]).toContain(events);
  });

  test("a join token opens its own conversation and no other", async () => {
    await intelligence.createThread({
      threadId: "sdk-own",
      userId: "ann",
      agentId: "a",
    });
    await intelligence.createThread({
      threadId: "sdk-other",
      userId: "ann",
      agentId: "a",
    });
    const connection = await intelligence.ɵconnectThread({
      threadId: "sdk-own",
      userId: "ann",
      agentId: "a",
    });
    const stranger = watch(
      connection?.joinToken as string,
      "thread:sdk-other",
      {
        stream_mode: "connect",
      },
    );
    await expect(withTimeout(stranger.joined)).rejects.toThrow(/unauthorized/);
    stranger.close();
  });

  test("connecting to a conversation that does not exist yet is empty, not an error", async () => {
    expect(
      await intelligence.ɵconnectThread({
        threadId: "never-created",
        userId: "ann",
        agentId: "a",
      }),
    ).toBeNull();
  });

  test("nobody sees another person's conversation", async () => {
    await intelligence.createThread({
      threadId: "sdk-ann",
      userId: "ann",
      agentId: "a",
    });
    const bobs = await intelligence.listThreads({
      userId: "bob",
      agentId: "a",
    });
    expect(bobs.threads.map((t) => t.id)).not.toContain("sdk-ann");
    expect(
      await intelligence.ɵconnectThread({
        threadId: "sdk-ann",
        userId: "bob",
        agentId: "a",
      }),
    ).toBeNull();
    const error = await intelligence
      .getThread({ threadId: "sdk-ann", userId: "bob" })
      .catch((e: unknown) => e);
    expect((error as { status?: number }).status).toBe(404);
  });
});

describe("the thread list", () => {
  test("lists, renames, archives and deletes through the SDK, announcing each change", async () => {
    const userId = "lister";
    const subscription = await intelligence.ɵsubscribeToThreads({ userId });
    const list = await intelligence.listThreads({ userId, agentId: "a" });
    const view = watch(
      subscription.joinToken,
      `user_meta:${list.joinCode}`,
      {},
      "terminal",
    );
    await withTimeout(view.joined);

    const seen: Array<{ operation: string; threadId: string }> = [];
    view.channel.on(
      "thread_metadata",
      (p: { operation: string; threadId: string }) => {
        seen.push({ operation: p.operation, threadId: p.threadId });
      },
    );

    await intelligence.createThread({
      threadId: "L1",
      userId,
      agentId: "a",
      name: "One",
    });
    await intelligence.updateThread({
      threadId: "L1",
      userId,
      agentId: "a",
      updates: { name: "Uno" },
    });
    await intelligence.archiveThread({ threadId: "L1", userId, agentId: "a" });
    await intelligence.deleteThread({ threadId: "L1", userId, agentId: "a" });
    await Bun.sleep(150);
    view.close();

    expect(seen).toEqual([
      { operation: "created", threadId: "L1" },
      { operation: "updated", threadId: "L1" },
      { operation: "archived", threadId: "L1" },
      { operation: "deleted", threadId: "L1" },
    ]);
  });

  test("entitlements report the deployment as licensed", async () => {
    const entitlements = await intelligence.getRuntimeEntitlements();
    expect(entitlements.status).toBe("ready");
  });
});
