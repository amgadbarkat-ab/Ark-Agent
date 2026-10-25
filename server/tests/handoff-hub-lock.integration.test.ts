/**
 * A hand-off's turn, locking its conversation on Ark Hub itself.
 *
 * A hop answers in a scratch thread minted for it. Ark Hub locks only a thread it already holds, and
 * nothing created that one, so on the desktop every hand-off was skipped with "thread not found"
 * before the colleague ever ran (DT Lab, v0.1.14). Tested against the hub and the platform client the
 * server actually uses, because a fake that locked any thread is how this went unnoticed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { HubConfig } from "../../hub/src/config";
import { type RunningHub, startHub } from "../../hub/src/server";
import { createTestDatabase, type TestDatabase } from "../../hub/tests/support";
import { acquireConversationLock } from "../src/copilot";

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

describe("a hand-off's conversation lock on Ark Hub", () => {
  test("a scratch thread nobody created is created, then locked", async () => {
    const threadId = randomUUID();
    const held = await acquireConversationLock(intelligence, {
      threadId,
      runId: randomUUID(),
      userId: "person",
      agentId: "research-analyst",
    });
    expect(held?.runId).toBeTruthy();
    const thread = await intelligence.getThread({ threadId, userId: "person" });
    expect(thread).toMatchObject({ id: threadId });
  });

  test("the conversation that asked, already running, is locked as it is", async () => {
    const threadId = randomUUID();
    await intelligence.getOrCreateThread({
      threadId,
      userId: "person",
      agentId: "chief-of-operations",
    });
    const held = await acquireConversationLock(intelligence, {
      threadId,
      runId: randomUUID(),
      userId: "person",
      agentId: "chief-of-operations",
    });
    expect(held?.runId).toBeTruthy();
  });

  test("a conversation somebody else is running in is a wait, not a failure", async () => {
    const threadId = randomUUID();
    const input = {
      threadId,
      userId: "person",
      agentId: "research-analyst",
    };
    expect(
      await acquireConversationLock(intelligence, {
        ...input,
        runId: randomUUID(),
      }),
    ).not.toBeNull();
    expect(
      await acquireConversationLock(intelligence, {
        ...input,
        runId: randomUUID(),
      }),
    ).toBeNull();
  });
});
