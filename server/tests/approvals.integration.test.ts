import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { approvalExecutors } from "../src/approvals/executors";
import {
  APPROVAL_TTL_MS,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalRefusedError,
  createApprovalStore,
  MAX_PENDING_PER_AGENT,
} from "../src/approvals/store";
import type { AuditStore } from "../src/audit";
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
const prefix = `approvals-${randomUUID()}`;
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

function harness(options: { now?: () => Date } = {}) {
  const applied: string[] = [];
  const events: { eventType: string }[] = [];
  const audit = {
    insert: async (event: { eventType: string }) => {
      events.push(event);
    },
  } as unknown as AuditStore;
  const store = createApprovalStore(database, {
    executors: {
      "routine.delete": async (approval) => {
        applied.push(approval.id);
        return "done";
      },
      "routine.update": async () => {
        throw new Error("The routine is gone.");
      },
    },
    auditStore: audit,
    ...options,
  });
  return { store, applied, events };
}

async function ask(
  store: ReturnType<typeof harness>["store"],
  owner: { id: string },
  by: { id: string },
  kind = "routine.delete",
) {
  return store.request({
    ownerUserId: owner.id,
    requestedByAgentId: by.id,
    kind,
    targetId: "routine-1",
    summary: "Delete the weekly report routine",
    payload: { routineId: "routine-1" },
  });
}

describe("approvals", () => {
  test("a request waits, names who asked, and is counted", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store, events } = harness();
    const made = await ask(store, owner, lead);
    expect(made.status).toBe("pending");
    expect(made.requestedByName).toBe("Ana");
    expect(await store.pendingCount(owner.id)).toBe(1);
    expect(events.map((e) => e.eventType)).toEqual(["approval.requested"]);
  });

  test("approving applies it once, and a second approval is refused", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store, applied, events } = harness();
    const made = await ask(store, owner, lead);
    const decided = await store.decide(owner.id, made.id, "approve");
    expect(decided.status).toBe("approved");
    expect(decided.result).toBe("done");
    expect(applied).toEqual([made.id]);
    await expect(
      store.decide(owner.id, made.id, "approve"),
    ).rejects.toBeInstanceOf(ApprovalNotPendingError);
    expect(applied).toEqual([made.id]);
    expect(events.map((e) => e.eventType)).toContain("approval.approved");
  });

  test("two approvals at the same moment apply it once", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store, applied } = harness();
    const made = await ask(store, owner, lead);
    const outcomes = await Promise.allSettled([
      store.decide(owner.id, made.id, "approve"),
      store.decide(owner.id, made.id, "approve"),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });

  test("rejecting applies nothing", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store, applied } = harness();
    const made = await ask(store, owner, lead);
    const decided = await store.decide(owner.id, made.id, "reject");
    expect(decided.status).toBe("rejected");
    expect(applied).toEqual([]);
  });

  test("nobody else can see or decide it, and their id reads as missing", async () => {
    const owner = await person();
    const stranger = await person();
    const lead = await employee(owner, "Ana");
    const { store, applied } = harness();
    const made = await ask(store, owner, lead);
    expect(await store.list(stranger.id)).toEqual([]);
    await expect(
      store.decide(stranger.id, made.id, "approve"),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(
      store.decide(owner.id, "apr_nothing", "approve"),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    expect(applied).toEqual([]);
    expect((await store.list(owner.id))[0]?.status).toBe("pending");
  });

  test("a change that cannot be applied is recorded as failed, with why", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store, events } = harness();
    const made = await ask(store, owner, lead, "routine.update");
    const decided = await store.decide(owner.id, made.id, "approve");
    expect(decided.status).toBe("failed");
    expect(decided.result).toBe("The routine is gone.");
    expect(events.map((e) => e.eventType)).toContain("approval.failed");
  });

  test("a request nobody answers lapses, and then cannot be approved", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    let clock = new Date();
    const { store, applied } = harness({ now: () => clock });
    const made = await ask(store, owner, lead);
    clock = new Date(clock.getTime() + APPROVAL_TTL_MS + 1000);
    expect(await store.pendingCount(owner.id)).toBe(0);
    await expect(
      store.decide(owner.id, made.id, "approve"),
    ).rejects.toBeInstanceOf(ApprovalNotPendingError);
    expect(applied).toEqual([]);
    expect((await store.list(owner.id, "all"))[0]?.status).toBe("expired");
  });

  test("one digital employee cannot fill an inbox", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store } = harness();
    for (let index = 0; index < MAX_PENDING_PER_AGENT; index += 1) {
      await ask(store, owner, lead);
    }
    await expect(ask(store, owner, lead)).rejects.toBeInstanceOf(
      ApprovalRefusedError,
    );
  });

  test("a kind nobody applies is refused up front", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const { store } = harness();
    await expect(
      ask(store, owner, lead, "agent.delete"),
    ).rejects.toBeInstanceOf(ApprovalRefusedError);
  });
});

describe("what approving each kind does", () => {
  const owner = { id: "owner-1" };
  const base = {
    id: "apr_1",
    ownerUserId: owner.id,
    requestedByAgentId: "lead",
    requestedByName: "Ana",
    targetAgentName: null,
    summary: "s",
    status: "approved" as const,
    result: null,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: new Date(),
  };

  test("a routine change takes only the fields a routine has", async () => {
    const calls: unknown[] = [];
    const executors = approvalExecutors({
      routines: {
        update: async (...args: unknown[]) => {
          calls.push(args);
          return {} as never;
        },
        remove: async () => {},
      },
      profiles: { get: async () => null, update: async () => ({}) as never },
      memories: { update: async () => ({}) as never, remove: async () => {} },
    });
    await executors["routine.update"]?.({
      ...base,
      kind: "routine.update",
      targetAgentId: "b",
      targetId: "r1",
      payload: {
        routineId: "r1",
        patch: { enabled: false, ownerUserId: "someone-else", agentId: "x" },
      },
    });
    expect(calls).toEqual([["owner-1", "r1", { enabled: false }]]);
  });

  test("a routine change that changes nothing is refused", async () => {
    const executors = approvalExecutors({
      routines: { update: async () => ({}) as never, remove: async () => {} },
      profiles: { get: async () => null, update: async () => ({}) as never },
      memories: { update: async () => ({}) as never, remove: async () => {} },
    });
    await expect(
      executors["routine.update"]?.({
        ...base,
        kind: "routine.update",
        targetAgentId: null,
        targetId: "r1",
        payload: { routineId: "r1", patch: {} },
      }),
    ).rejects.toThrow("does not change anything");
  });

  test("instructions cannot be changed on a digital employee that is not the owner's", async () => {
    const updates: unknown[] = [];
    const executors = approvalExecutors({
      routines: { update: async () => ({}) as never, remove: async () => {} },
      profiles: {
        get: async () => ({ ownerUserId: "someone-else" }) as never,
        update: async (...args: unknown[]) => {
          updates.push(args);
          return {} as never;
        },
      },
      memories: { update: async () => ({}) as never, remove: async () => {} },
    });
    await expect(
      executors["instructions.update"]?.({
        ...base,
        kind: "instructions.update",
        targetAgentId: "b",
        targetId: null,
        payload: { persona: "Be terse." },
      }),
    ).rejects.toThrow("no longer yours");
    expect(updates).toEqual([]);
  });
});

describe("what approving a memory change does", () => {
  const base = {
    id: "apr_1",
    ownerUserId: "owner-1",
    requestedByAgentId: "lead",
    requestedByName: "Ana",
    targetAgentId: "ben",
    targetAgentName: "Ben",
    summary: "s",
    status: "approved" as const,
    result: null,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: new Date(),
  };

  test("rewording marks the memory as agreed by the owner, and deleting removes only that one", async () => {
    const updates: unknown[] = [];
    const removed: unknown[] = [];
    const executors = approvalExecutors({
      routines: { update: async () => ({}) as never, remove: async () => {} },
      profiles: { get: async () => null, update: async () => ({}) as never },
      memories: {
        update: async (...args: unknown[]) => {
          updates.push(args);
          return {} as never;
        },
        remove: async (...args: unknown[]) => {
          removed.push(args);
        },
      },
    });
    await executors["memory.update"]?.({
      ...base,
      kind: "memory.update",
      targetId: "mem_1",
      payload: { memoryId: "mem_1", content: "Reports go out on Thursdays." },
    });
    await executors["memory.delete"]?.({
      ...base,
      kind: "memory.delete",
      targetId: "mem_2",
      payload: { memoryId: "mem_2" },
    });
    expect(updates).toEqual([
      ["owner-1", "mem_1", "Reports go out on Thursdays.", "approved"],
    ]);
    expect(removed).toEqual([["owner-1", "mem_2"]]);
  });
});
