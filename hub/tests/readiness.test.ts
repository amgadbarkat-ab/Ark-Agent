import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HubConfig } from "../src/config";
import { type RunningHub, startHub } from "../src/server";
import { createTestDatabase, type TestDatabase } from "./support";

/**
 * `/ready` is whether to send the hub requests: its database answers and it has not been told to stop.
 * `/health` stays whether it is alive, and does not ask the database.
 */

const config: HubConfig = {
  port: 0,
  databaseUrl: "unused",
  apiKey: "k".repeat(40),
  joinSecret: "j".repeat(40),
  joinTokenTtlSeconds: 3600,
  defaultLockTtlSeconds: 60,
  bus: "postgres",
};
let database: TestDatabase;
let running: RunningHub;

beforeAll(async () => {
  database = await createTestDatabase();
  running = await startHub(config, { sql: database.sql });
});
afterAll(async () => {
  await running.stop();
  await database.drop();
});

const ready = async () => {
  const response = await fetch(`${running.apiUrl}/ready`);
  return { status: response.status, body: await response.json() };
};

test("is ready when the database answers, with no credentials asked for", async () => {
  expect(await ready()).toEqual({ status: 200, body: { status: "ok" } });
});

test("is not ready when the database does not answer, while still alive", async () => {
  const original = running.hub.store.ping.bind(running.hub.store);
  running.hub.store.ping = async () => {
    throw new Error("connection refused");
  };
  try {
    expect(await ready()).toEqual({
      status: 503,
      body: { status: "unavailable" },
    });
    expect((await fetch(`${running.apiUrl}/health`)).status).toBe(200);
  } finally {
    running.hub.store.ping = original;
  }
});

test("says so as soon as it has been told to stop", async () => {
  running.hub.draining = true;
  try {
    expect(await ready()).toEqual({
      status: 503,
      body: { status: "draining" },
    });
  } finally {
    running.hub.draining = false;
  }
});
