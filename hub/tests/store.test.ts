import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Conflict,
  HubStore,
  LockConflict,
  NotFound,
  isTerminalEvent,
} from "../src/store";
import { createTestDatabase, type TestDatabase } from "./support";

let database: TestDatabase;
let store: HubStore;

beforeAll(async () => {
  database = await createTestDatabase();
  store = new HubStore(database.sql);
});
afterAll(async () => {
  await database.drop();
});

const event = (
  type: string,
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  type,
  ...extra,
  metadata: { cpki_event_id: id, cpki_event_seq: 1 },
});

describe("threads", () => {
  test("creates, reads and refuses a duplicate", async () => {
    const created = await store.createThread({
      threadId: "t-create",
      userId: "ann",
      agentId: "general",
      name: "First",
    });
    expect(created).toMatchObject({
      id: "t-create",
      name: "First",
      agentId: "general",
      createdById: "ann",
      archived: false,
    });
    expect((await store.getThread("t-create", "ann"))?.name).toBe("First");
    await expect(
      store.createThread({
        threadId: "t-create",
        userId: "ann",
        agentId: "general",
      }),
    ).rejects.toBeInstanceOf(Conflict);
  });

  test("one person cannot see or change another's thread", async () => {
    await store.createThread({
      threadId: "t-private",
      userId: "ann",
      agentId: "a",
    });
    expect(await store.getThread("t-private", "bob")).toBeNull();
    expect(
      await store.updateThread({
        threadId: "t-private",
        userId: "bob",
        name: "x",
      }),
    ).toBeNull();
    expect(await store.deleteThread("t-private", "bob")).toBe(false);
    expect(await store.getThread("t-private", "ann")).not.toBeNull();
  });

  test("renames, archives and deletes", async () => {
    await store.createThread({
      threadId: "t-edit",
      userId: "cy",
      agentId: "a",
    });
    expect(
      (
        await store.updateThread({
          threadId: "t-edit",
          userId: "cy",
          name: "Renamed",
        })
      )?.name,
    ).toBe("Renamed");
    const archived = await store.updateThread({
      threadId: "t-edit",
      userId: "cy",
      archived: true,
    });
    expect(archived?.archived).toBe(true);
    expect(archived?.name).toBe("Renamed");
    expect(await store.deleteThread("t-edit", "cy")).toBe(true);
    expect(await store.getThread("t-edit", "cy")).toBeNull();
  });

  test("lists newest first, hides archived, and pages with a cursor", async () => {
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      await store.createThread({
        threadId: `list-${id}`,
        userId: "dee",
        agentId: "a",
      });
    }
    await store.updateThread({
      threadId: "list-p3",
      userId: "dee",
      archived: true,
    });

    const first = await store.listThreads({ userId: "dee", limit: 2 });
    expect(first.threads.map((t) => t.id)).toEqual(["list-p5", "list-p4"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.listThreads({
      userId: "dee",
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.threads.map((t) => t.id)).toEqual(["list-p2", "list-p1"]);
    expect(second.nextCursor).toBeNull();

    const all = await store.listThreads({
      userId: "dee",
      includeArchived: true,
    });
    expect(all.threads.map((t) => t.id)).toContain("list-p3");
  });

  test("pages through threads created within the same millisecond without skipping one", async () => {
    // Microseconds apart, which a JavaScript Date cannot hold: a cursor that went through one would
    // round them all to the same moment and skip the ones between the pages. (The offset is computed
    // in SQL because the driver would round a timestamp passed as a parameter, too.)
    for (const [id, micros] of [
      ["same-ms-1", 100],
      ["same-ms-2", 200],
      ["same-ms-3", 300],
      ["same-ms-4", 400],
    ] as const) {
      await database.sql`
        insert into hub_threads (id, user_id, agent_id, created_at, updated_at)
        values (
          ${id}, 'fay', 'a',
          timestamptz '2026-01-01 00:00:00+00' + ${micros}::int * interval '1 microsecond',
          timestamptz '2026-01-01 00:00:00+00' + ${micros}::int * interval '1 microsecond'
        )`;
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await store.listThreads({
        userId: "fay",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.threads.map((t) => t.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["same-ms-4", "same-ms-3", "same-ms-2", "same-ms-1"]);
  });

  test("lists only the requested agent's threads", async () => {
    await store.createThread({ threadId: "ag-1", userId: "eve", agentId: "x" });
    await store.createThread({ threadId: "ag-2", userId: "eve", agentId: "y" });
    const listed = await store.listThreads({ userId: "eve", agentId: "x" });
    expect(listed.threads.map((t) => t.id)).toEqual(["ag-1"]);
  });
});

describe("run lock", () => {
  const lock = (threadId: string, runId: string, ttlSeconds = 60) =>
    store.acquireLock({
      threadId,
      runId,
      userId: "lou",
      agentId: "a",
      ttlSeconds,
    });

  test("is exclusive, idempotent for the same run, and releasable", async () => {
    await store.createThread({ threadId: "lk-1", userId: "lou", agentId: "a" });
    const granted = await lock("lk-1", "run-1");
    expect(granted.lock.key).toBe("thread:lk-1");
    await lock("lk-1", "run-1");
    await expect(lock("lk-1", "run-2")).rejects.toBeInstanceOf(LockConflict);
    expect(await store.holdsLock("lk-1", "run-1")).toBe(true);
    expect(
      await store.renewLock({
        threadId: "lk-1",
        runId: "run-1",
        ttlSeconds: 60,
      }),
    ).toBe(true);
    expect(
      await store.renewLock({
        threadId: "lk-1",
        runId: "run-2",
        ttlSeconds: 60,
      }),
    ).toBe(false);
    await store.releaseLock("lk-1", "run-1");
    await lock("lk-1", "run-2");
  });

  test("an expired lock can be taken over", async () => {
    await store.createThread({ threadId: "lk-2", userId: "lou", agentId: "a" });
    await store.acquireLock({
      threadId: "lk-2",
      runId: "old",
      userId: "lou",
      agentId: "a",
      ttlSeconds: 1,
    });
    await Bun.sleep(1200);
    expect(await store.activeLock("lk-2")).toBeNull();
    await lock("lk-2", "new");
    expect((await store.activeLock("lk-2"))?.runId).toBe("new");
  });

  test("cannot lock a thread that is not yours or does not exist", async () => {
    await store.createThread({
      threadId: "lk-3",
      userId: "someone",
      agentId: "a",
    });
    await expect(lock("lk-3", "r")).rejects.toBeInstanceOf(NotFound);
    await expect(lock("missing", "r")).rejects.toBeInstanceOf(NotFound);
  });
});

describe("events", () => {
  test("stores in order, ignores a resend, and rebuilds messages", async () => {
    await store.createThread({ threadId: "ev-1", userId: "max", agentId: "a" });
    const batch = [
      event("RUN_STARTED", "e1", {
        runId: "r1",
        input: { messages: [{ id: "u1", role: "user", content: "hi" }] },
      }),
      event("TEXT_MESSAGE_START", "e2", { messageId: "a1", role: "assistant" }),
      event("TEXT_MESSAGE_CONTENT", "e3", { messageId: "a1", delta: "yo" }),
      event("RUN_FINISHED", "e4", { runId: "r1" }),
    ];
    const first = await store.appendEvents("ev-1", "r1", batch);
    expect(first.map((e) => e.eventId)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(first.every((e, i) => i === 0 || e.seq > first[i - 1]!.seq)).toBe(
      true,
    );

    const resent = await store.appendEvents("ev-1", "r1", batch);
    expect(resent).toEqual([]);

    expect(await store.threadMessages("ev-1")).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "yo" },
    ]);
    expect(await store.latestEventId("ev-1")).toBe("e4");
    expect((await store.getThread("ev-1", "max"))?.lastRunAt).toBeDefined();
  });

  test("replays a whole thread, one run, or only what follows a cursor", async () => {
    await store.createThread({ threadId: "ev-2", userId: "max", agentId: "a" });
    await store.appendEvents("ev-2", "r1", [
      event("RUN_STARTED", "a1", { runId: "r1" }),
      event("RUN_FINISHED", "a2", { runId: "r1" }),
    ]);
    await store.appendEvents("ev-2", "r2", [
      event("RUN_STARTED", "b1", { runId: "r2" }),
      event("RUN_FINISHED", "b2", { runId: "r2" }),
    ]);
    const ids = async (o?: Parameters<HubStore["eventsForReplay"]>[1]) =>
      (await store.eventsForReplay("ev-2", o)).map((e) => e.eventId);
    expect(await ids()).toEqual(["a1", "a2", "b1", "b2"]);
    expect(await ids({ runId: "r2" })).toEqual(["b1", "b2"]);
    expect(await ids({ afterEventId: "a2" })).toEqual(["b1", "b2"]);
    // An unknown cursor replays everything rather than silently dropping history.
    expect(await ids({ afterEventId: "nope" })).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
    ]);
  });

  test("deleting a thread removes its events and lock", async () => {
    await store.createThread({ threadId: "ev-3", userId: "max", agentId: "a" });
    await store.appendEvents("ev-3", "r", [event("RUN_STARTED", "z1")]);
    await store.acquireLock({
      threadId: "ev-3",
      runId: "r",
      userId: "max",
      agentId: "a",
      ttlSeconds: 60,
    });
    await store.deleteThread("ev-3", "max");
    expect(await store.eventsForReplay("ev-3")).toEqual([]);
    expect(await store.activeLock("ev-3")).toBeNull();
  });

  test("recognises the events that end a run", () => {
    expect(isTerminalEvent({ type: "RUN_FINISHED" })).toBe(true);
    expect(isTerminalEvent({ type: "RUN_ERROR" })).toBe(true);
    expect(isTerminalEvent({ type: "RUN_STARTED" })).toBe(false);
  });
});
