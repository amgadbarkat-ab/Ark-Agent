import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AuditStore } from "../src/audit";
import {
  createMemoryStore,
  MAX_MEMORIES_PER_AGENT,
  MAX_MEMORY_CHARACTERS,
  MEMORIES_PER_RUN,
  MemoryNotFoundError,
  MemoryRefusedError,
  memoryGuidance,
} from "../src/memories/store";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const company = createAccountStore(database, { billingMode: "internal" });
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
  undefined,
  company,
);
const prefix = `memories-${randomUUID()}`;
const userIds: string[] = [];
const agentIds: string[] = [];

afterEach(async () => {
  for (const id of agentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const id of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});
afterAll(async () => {
  await database.$client.close();
});

async function person() {
  const id = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Approvals Test" });
  userIds.push(id);
  await company.ensureTenant(id);
  return { id, role: "user" as const };
}

async function employee(owner: { id: string; role: "user" }, name: string) {
  const made = await profiles.create(owner, {
    name,
    title: "Teammate",
    roleDescription: `${name} works.`,
    visibility: "private",
  });
  agentIds.push(made.id);
  return made;
}

const events: { eventType: string; payload?: Record<string, unknown> }[] = [];
const store = createMemoryStore(database, {
  auditStore: {
    insert: async (event: { eventType: string }) => {
      events.push(event);
    },
  } as unknown as AuditStore,
});

describe("what a digital employee keeps in mind", () => {
  test("the owner's employee keeps a memory, and the owner can read it back", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    const kept = await store.add({
      ownerUserId: owner.id,
      agentId: ana.id,
      content: "  Prefers short answers.  ",
      source: "agent",
    });
    expect(kept.content).toBe("Prefers short answers.");
    expect(kept.id.startsWith("mem_")).toBe(true);
    expect((await store.list(owner.id, ana.id)).map((m) => m.content)).toEqual([
      "Prefers short answers.",
    ]);
  });

  test("nobody else can read, change or delete it, and it reads as missing", async () => {
    const owner = await person();
    const stranger = await person();
    const ana = await employee(owner, "Ana");
    const kept = await store.add({
      ownerUserId: owner.id,
      agentId: ana.id,
      content: "Likes Greek.",
      source: "person",
    });
    expect(await store.list(stranger.id, ana.id)).toEqual([]);
    await expect(
      store.update(stranger.id, kept.id, "x", "person"),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    await expect(store.remove(stranger.id, kept.id)).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    expect(await store.list(owner.id, ana.id)).toHaveLength(1);
  });

  test("only an employee's owner can give it memories, not someone it is shared with", async () => {
    const owner = await person();
    const colleague = await person();
    const shared = await profiles.create(owner, {
      name: "Shared",
      title: "Teammate",
      roleDescription: "Shared works.",
      visibility: "public",
    });
    agentIds.push(shared.id);
    await expect(
      store.add({
        ownerUserId: colleague.id,
        agentId: shared.id,
        content: "Remember me",
        source: "agent",
      }),
    ).rejects.toBeInstanceOf(MemoryRefusedError);
  });

  test("a password, a key or a card number is never kept", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    for (const text of [
      "The password is hunter2hunter2",
      // Built from parts, so the file never holds a string that looks like a live key to a scanner.
      `api_key = ${["sk", "live", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}`,
      "My card is 4111 1111 1111 1111",
    ]) {
      await expect(
        store.add({
          ownerUserId: owner.id,
          agentId: ana.id,
          content: text,
          source: "agent",
        }),
      ).rejects.toBeInstanceOf(MemoryRefusedError);
    }
    expect(await store.list(owner.id, ana.id)).toEqual([]);
  });

  test("empty and over-long text are refused in words", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    await expect(
      store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: "   ",
        source: "agent",
      }),
    ).rejects.toThrow("has to say something");
    await expect(
      store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: "x".repeat(MAX_MEMORY_CHARACTERS + 1),
        source: "agent",
      }),
    ).rejects.toThrow("characters at most");
  });

  test("a hundred is the most one employee keeps", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    for (let index = 0; index < MAX_MEMORIES_PER_AGENT; index += 1) {
      await store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: `Fact number ${index}`,
        source: "agent",
      });
    }
    await expect(
      store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: "One more",
        source: "agent",
      }),
    ).rejects.toThrow("Forget one first");
  });

  test("two adds at the same moment cannot take it past a hundred", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    for (let index = 0; index < MAX_MEMORIES_PER_AGENT - 1; index += 1) {
      await store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: `Fact ${index}`,
        source: "agent",
      });
    }
    const both = await Promise.allSettled([
      store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: "A",
        source: "agent",
      }),
      store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: "B",
        source: "agent",
      }),
    ]);
    expect(both.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await store.list(owner.id, ana.id)).toHaveLength(
      MAX_MEMORIES_PER_AGENT,
    );
  });

  test("correcting and deleting work, and the trail records who and which, never the text", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    events.length = 0;
    const kept = await store.add({
      ownerUserId: owner.id,
      agentId: ana.id,
      content: "Works Monday to Friday.",
      source: "agent",
    });
    const changed = await store.update(
      owner.id,
      kept.id,
      "Works Monday to Thursday.",
      "person",
    );
    expect(changed.content).toBe("Works Monday to Thursday.");
    expect(changed.source).toBe("person");
    await store.remove(owner.id, kept.id);
    expect(await store.list(owner.id, ana.id)).toEqual([]);
    expect(events.map((e) => e.eventType)).toEqual([
      "memory.added",
      "memory.changed",
      "memory.deleted",
    ]);
    expect(JSON.stringify(events)).not.toContain("Monday");
  });

  test("a run gets the newest thirty of each employee, and only the owner's", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    const ben = await employee(owner, "Ben");
    for (let index = 0; index < MEMORIES_PER_RUN + 5; index += 1) {
      await store.add({
        ownerUserId: owner.id,
        agentId: ana.id,
        content: `Fact ${index}`,
        source: "agent",
      });
    }
    await store.add({
      ownerUserId: owner.id,
      agentId: ben.id,
      content: "Ben's one",
      source: "agent",
    });
    const held = await store.forRun(owner.id, [ana.id, ben.id]);
    expect(held.get(ana.id)).toHaveLength(MEMORIES_PER_RUN);
    expect(held.get(ana.id)?.[0]?.content).toBe(`Fact ${MEMORIES_PER_RUN + 4}`);
    expect(held.get(ben.id)?.map((m) => m.content)).toEqual(["Ben's one"]);
    const stranger = await person();
    expect((await store.forRun(stranger.id, [ana.id])).size).toBe(0);
  });

  test("the paragraph lists them oldest first with their ids, and says what never to keep", () => {
    const text = memoryGuidance([
      {
        id: "mem_2",
        agentId: "a",
        content: "Newer",
        source: "agent",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "mem_1",
        agentId: "a",
        content: "Older",
        source: "agent",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(text.indexOf("[mem_1] Older")).toBeLessThan(
      text.indexOf("[mem_2] Newer"),
    );
    expect(text).toContain("Never keep passwords");
    expect(memoryGuidance([])).toContain("You have no memories yet.");
  });
});
