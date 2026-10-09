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
import { HubConfigError, type HubConfig, loadConfig } from "../src/config";
import { hubMetrics } from "../src/metrics";
import { type RunningHub, startHub } from "../src/server";
import { createTestDatabase, type TestDatabase } from "./support";

/**
 * What the hub counts, and that it counts things and not conversations: how many events it stored,
 * how many sockets are open and of which kind, and how often a browser had to be read back from the
 * log. None of it is labelled with a thread, a run or a person.
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

class OneReply extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const base = { threadId: input.threadId, runId: input.runId };
      const emit = (event: Record<string, unknown>) =>
        observer.next(event as unknown as BaseEvent);
      emit({ type: EventType.RUN_STARTED, ...base });
      emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "a",
        role: "assistant",
      });
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "a",
        delta: "hi",
      });
      emit({ type: EventType.TEXT_MESSAGE_END, messageId: "a" });
      emit({ type: EventType.RUN_FINISHED, ...base });
      observer.complete();
    });
  }
}

/** One number out of the text a scraper reads. */
async function value(name: string, labels = ""): Promise<number> {
  const text = await hubMetrics.render();
  const match = text.match(new RegExp(`^${name}${labels} ([\\d.]+)$`, "m"));
  return Number(match?.[1] ?? 0);
}

async function until(check: () => Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("it never became true");
    await Bun.sleep(20);
  }
}

describe("the hub's numbers", () => {
  test("count events stored, sockets by kind, and a browser read back from the log", async () => {
    const stored = await value("ark_hub_events_stored_total");
    const joins = await value("ark_hub_catchups_total", '\\{reason="join"\\}');

    const threadId = "metrics-1";
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
    await lastValueFrom(
      new IntelligenceAgentRunner({
        url: intelligence.ɵgetRunnerWsUrl(),
        authToken: intelligence.ɵgetRunnerAuthToken(),
      }).run({
        threadId,
        agent: new OneReply(),
        input: {
          threadId,
          runId: "run-1",
          messages: [{ id: "u", role: "user", content: "hi" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
      { defaultValue: undefined },
    );
    // Five events were stored.
    await until(
      async () => (await value("ark_hub_events_stored_total")) >= stored + 5,
    );

    const before = await value("ark_hub_sockets", '\\{endpoint="client"\\}');
    const connection = await intelligence.ɵconnectThread({
      threadId,
      userId: "ann",
      agentId: "general",
    });
    const socket = new Socket(`${running.wsUrl}/client`, {
      params: { join_token: connection?.joinToken as string },
    });
    socket.connect();
    const channel = socket.channel(`thread:${threadId}`, {
      stream_mode: "connect",
      last_seen_event_id: null,
    });
    const complete = new Promise<void>((resolve) => {
      channel.on("replay_complete", () => resolve());
    });
    channel.join();
    await complete;

    expect(await value("ark_hub_sockets", '\\{endpoint="client"\\}')).toBe(
      before + 1,
    );
    expect(await value("ark_hub_catchups_total", '\\{reason="join"\\}')).toBe(
      joins + 1,
    );

    channel.leave();
    socket.disconnect();
    await until(
      async () =>
        (await value("ark_hub_sockets", '\\{endpoint="client"\\}')) === before,
    );
  });

  test("carry no thread, run, person or conversation text", async () => {
    const text = await hubMetrics.render();
    expect(text).not.toContain("metrics-1");
    expect(text).not.toContain("run-1");
    expect(text).not.toContain("ann");
    expect(text).not.toContain('"hi"');
  });
});

describe("the setting", () => {
  const base = {
    HUB_API_KEY: "k".repeat(40),
    HUB_JOIN_SECRET: "j".repeat(40),
    DATABASE_URL: "postgres://x",
  };
  test("is optional, a real port, and not the one the hub is served on", () => {
    expect(loadConfig(base).metricsPort).toBeUndefined();
    expect(loadConfig({ ...base, HUB_METRICS_PORT: "9465" }).metricsPort).toBe(
      9465,
    );
    expect(() => loadConfig({ ...base, HUB_METRICS_PORT: "70000" })).toThrow(
      HubConfigError,
    );
    expect(() =>
      loadConfig({ ...base, HUB_PORT: "7100", HUB_METRICS_PORT: "7100" }),
    ).toThrow(/must not be the port/);
  });
});
