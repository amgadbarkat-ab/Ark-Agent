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

/**
 * Two hub processes on one database, which is what a second replica or a rolling update is.
 *
 * The runner (the thing that executes a coworker's turn and writes its events) is connected to one;
 * the person watching is connected to the other. Before the bus was shared this split a conversation's
 * live stream: the watcher saw nothing until the run was over.
 */

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
let first: RunningHub;
let second: RunningHub;
let viaFirst: CopilotKitIntelligence;
let viaSecond: CopilotKitIntelligence;

beforeAll(async () => {
  database = await createTestDatabase();
  first = await startHub(config, { sql: database.sql });
  second = await startHub(config, { sql: database.sql });
  const clientFor = (hub: RunningHub) =>
    new CopilotKitIntelligence({
      apiUrl: hub.apiUrl,
      wsUrl: hub.wsUrl,
      apiKey: API_KEY,
    });
  viaFirst = clientFor(first);
  viaSecond = clientFor(second);
});
afterAll(async () => {
  await first.stop();
  await second.stop();
  await database.drop();
});

/** Replies in two halves, pausing between them until `gate` opens; the second half can be big. */
class ScriptedAgent extends AbstractAgent {
  constructor(
    private readonly gate: Promise<void>,
    private readonly bigResult = false,
  ) {
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
          // An event larger than a NOTIFY can carry: it has to cross by the overflow table.
          delta: this.bigResult ? `lo ${"é".repeat(40_000)}` : "lo",
        });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: "a1" });
        emit({ type: EventType.RUN_FINISHED, ...base });
        observer.complete();
      });
    });
  }
}

const inputFor = (threadId: string, runId: string): RunAgentInput => ({
  threadId,
  runId,
  messages: [{ id: `u-${runId}`, role: "user", content: "hi" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

const withTimeout = <T>(promise: Promise<T>, ms = 10_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

/** A browser on the SECOND hub joining a conversation, collecting what it is sent. */
function watchOnSecond(joinToken: string, threadId: string) {
  const socket = new Socket(`${second.wsUrl}/client`, {
    params: { join_token: joinToken },
  });
  socket.connect();
  const channel = socket.channel(`thread:${threadId}`, {
    stream_mode: "connect",
    last_seen_event_id: null,
  });
  const events: Array<Record<string, unknown>> = [];
  let sawTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => {
    sawTerminal = resolve;
  });
  channel.on("ag_ui_event", (payload: Record<string, unknown>) => {
    events.push(payload);
    if (payload.type === "RUN_FINISHED") sawTerminal();
  });
  const joined = new Promise<void>((resolve, reject) => {
    channel
      .join()
      .receive("ok", () => resolve())
      .receive("error", (response: unknown) =>
        reject(new Error(`join refused: ${JSON.stringify(response)}`)),
      );
  });
  return {
    events,
    joined,
    terminal,
    close() {
      channel.leave();
      socket.disconnect();
    },
  };
}

async function joinTokenFor(threadId: string) {
  const connection = await viaSecond.ɵconnectThread({
    threadId,
    userId: "ann",
    agentId: "general",
  });
  return connection?.joinToken as string;
}

describe("a runner on one hub and a person on another", () => {
  test("the person sees the run live, in order, with nothing missed or doubled", async () => {
    const threadId = "scale-live-1";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await viaFirst.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    await viaFirst.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });
    const runner = new IntelligenceAgentRunner({
      url: viaFirst.ɵgetRunnerWsUrl(),
      authToken: viaFirst.ɵgetRunnerAuthToken(),
    });
    const finished = lastValueFrom(
      runner.run({
        threadId,
        agent: new ScriptedAgent(gate),
        input: inputFor(threadId, "run-1"),
      }),
      { defaultValue: undefined },
    );

    const view = watchOnSecond(await joinTokenFor(threadId), threadId);
    await withTimeout(view.joined);
    // The first half has been said and is on the other hub's screen before the run ends.
    const start = Date.now();
    while (
      !view.events.some((event) => event.type === "TEXT_MESSAGE_CONTENT") &&
      Date.now() - start < 8000
    ) {
      await Bun.sleep(20);
    }
    expect(view.events.map((event) => event.type)).toContain("RUN_STARTED");
    release();
    await withTimeout(view.terminal);
    await withTimeout(finished);
    view.close();

    expect(view.events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  test("an event larger than a NOTIFY crosses to the other hub whole", async () => {
    const threadId = "scale-big-1";
    await viaFirst.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    await viaFirst.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new IntelligenceAgentRunner({
      url: viaFirst.ɵgetRunnerWsUrl(),
      authToken: viaFirst.ɵgetRunnerAuthToken(),
    });
    const finished = lastValueFrom(
      runner.run({
        threadId,
        agent: new ScriptedAgent(gate, true),
        input: inputFor(threadId, "run-1"),
      }),
      { defaultValue: undefined },
    );
    const view = watchOnSecond(await joinTokenFor(threadId), threadId);
    await withTimeout(view.joined);
    release();
    await withTimeout(view.terminal);
    await withTimeout(finished);
    view.close();

    const deltas = view.events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => String(event.delta));
    expect(deltas.join("")).toBe(`hello ${"é".repeat(40_000)}`);
  });

  test("when the bus loses its connection mid-run, the person still ends up with every event", async () => {
    const threadId = "scale-gap-1";
    await viaFirst.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    await viaFirst.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new IntelligenceAgentRunner({
      url: viaFirst.ɵgetRunnerWsUrl(),
      authToken: viaFirst.ɵgetRunnerAuthToken(),
    });
    const finished = lastValueFrom(
      runner.run({
        threadId,
        agent: new ScriptedAgent(gate),
        input: inputFor(threadId, "run-1"),
      }),
      { defaultValue: undefined },
    );
    const view = watchOnSecond(await joinTokenFor(threadId), threadId);
    await withTimeout(view.joined);
    await Bun.sleep(200);

    // Every listening connection is cut, mid-run, then the rest of the run happens.
    await database.sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and query ilike 'listen %'`;
    release();
    await withTimeout(finished);
    await withTimeout(view.terminal, 20_000);
    view.close();

    const types = view.events.map((event) => event.type);
    expect(types).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  test("a stop pressed on one hub reaches the runner on the other", async () => {
    const threadId = "scale-stop-1";
    await viaFirst.createThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    await viaFirst.ɵacquireThreadLock({
      threadId,
      runId: "run-1",
      userId: "ann",
      agentId: "general",
    });
    // What the runner's socket on the first hub is told about this run.
    const told: unknown[] = [];
    first.hub.bus.subscribe("runner:run-1", (event, body) =>
      told.push([event, body]),
    );
    const socket = new Socket(`${second.wsUrl}/client`, {
      params: { join_token: await joinTokenFor(threadId) },
    });
    socket.connect();
    const channel = socket.channel(`thread:${threadId}`, {
      stream_mode: "connect",
      last_seen_event_id: null,
    });
    await withTimeout(
      new Promise<void>((resolve, reject) =>
        channel
          .join()
          .receive("ok", () => resolve())
          .receive("error", (r: unknown) =>
            reject(new Error(JSON.stringify(r))),
          ),
      ),
    );
    const reply = await withTimeout(
      new Promise<string>((resolve) =>
        channel
          .push("stop_run", { run_id: "run-1" })
          .receive("ok", () => resolve("ok"))
          .receive("error", (r: unknown) => resolve(JSON.stringify(r))),
      ),
    );
    expect(reply).toBe("ok");
    const start = Date.now();
    while (told.length === 0 && Date.now() - start < 8000) await Bun.sleep(20);
    channel.leave();
    socket.disconnect();
    expect(told).toEqual([
      ["ag-ui", { type: "CUSTOM", name: "stop", value: { run_id: "run-1" } }],
    ]);
  });
});
