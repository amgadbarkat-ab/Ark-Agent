import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAccountStore, entitlementOf } from "../src/accounts/store";
import { createDatabase } from "../src/db/client";
import {
  subscriptions,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made: string[] = [];

async function person(label = "acct") {
  const id = `${label}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}

afterEach(async () => {
  for (const id of made.splice(0)) {
    const memberships = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const m of memberships)
      await database.delete(tenants).where(eq(tenants.id, m.tenantId));
  }
});
afterAll(async () => {
  await database.$client.close();
});

describe("providing an account", () => {
  test("a person gets one account, once, however many requests race", async () => {
    const ann = await person();
    const store = createAccountStore(database);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => store.ensureTenant(ann)),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await database
      .select()
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, ann));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("owner");
  });

  test("on an internal deployment the account is unlimited and free", async () => {
    const ann = await person();
    const entitlement = await createAccountStore(database, {
      billingMode: "internal",
    }).entitlementFor(ann);
    expect(entitlement).toMatchObject({
      planId: "internal",
      canRun: true,
      maxActiveBots: null,
    });
  });

  test("on a subscription deployment a new account cannot run bots until it has a plan", async () => {
    const ann = await person();
    const store = createAccountStore(database, {
      billingMode: "subscriptions",
    });
    const before = await store.entitlementFor(ann);
    expect(before).toMatchObject({ canRun: false, blockedCode: "no_plan" });
    expect(before.blockedReason).toMatch(/choose a plan/i);

    const tenantId = await store.ensureTenant(ann);
    await store.applySubscription(tenantId, {
      planId: "team",
      status: "active",
      provider: "manual",
    });
    expect(await store.entitlementFor(ann)).toMatchObject({
      planId: "team",
      planName: "Ark Team",
      canRun: true,
      maxActiveBots: 15,
    });
  });

  test("two people never share an account", async () => {
    const ann = await person();
    const bob = await person();
    const store = createAccountStore(database);
    expect(await store.ensureTenant(ann)).not.toBe(
      await store.ensureTenant(bob),
    );
  });
});

describe("what an account may do", () => {
  test("a suspended account cannot run, says why, and is restored by resuming", async () => {
    const ann = await person();
    const store = createAccountStore(database);
    const tenantId = await store.ensureTenant(ann);
    await store.suspend(tenantId, "payment dispute");
    const suspended = await store.entitlementFor(ann);
    expect(suspended).toMatchObject({
      canRun: false,
      blockedCode: "suspended",
    });
    expect(suspended.blockedReason).toContain("payment dispute");
    await store.resume(tenantId);
    expect((await store.entitlementFor(ann)).canRun).toBe(true);
  });

  test("a cancelled subscription stops runs; a failed card does not", async () => {
    const ann = await person();
    const store = createAccountStore(database, {
      billingMode: "subscriptions",
    });
    const tenantId = await store.ensureTenant(ann);
    await store.applySubscription(tenantId, {
      planId: "agent",
      status: "past_due",
    });
    expect((await store.entitlementFor(ann)).canRun).toBe(true);
    await store.applySubscription(tenantId, { status: "canceled" });
    expect(await store.entitlementFor(ann)).toMatchObject({
      canRun: false,
      blockedCode: "canceled",
    });
  });

  test("an unknown plan is refused rather than stored", async () => {
    const ann = await person();
    const store = createAccountStore(database);
    const tenantId = await store.ensureTenant(ann);
    await expect(
      store.applySubscription(tenantId, { planId: "platinum" }),
    ).rejects.toThrow(/unknown plan/i);
    const [row] = await database
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId));
    expect(row?.planId).toBe("internal");
  });

  test("a plan the catalogue no longer knows allows nothing, rather than everything", () => {
    const e = entitlementOf(
      { id: "t", status: "active", suspendedReason: null },
      { planId: "retired-plan", status: "active" },
    );
    expect(e.maxActiveBots).toBe(0);
  });
});

describe("the administrator's list", () => {
  test("pages newest first, finds by email, and carries the owner", async () => {
    const store = createAccountStore(database);
    const ann = await person("findme");
    await store.ensureTenant(ann);
    const found = await store.listForAdmin({ search: ann });
    expect(found.tenants).toHaveLength(1);
    expect(found.tenants[0]).toMatchObject({
      ownerEmail: `${ann}@example.com`,
      planId: "internal",
      suspended: false,
      activeBots: 0,
    });

    const first = await store.listForAdmin({ limit: 1 });
    expect(first.tenants).toHaveLength(1);
    if (first.nextCursor) {
      const second = await store.listForAdmin({
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.tenants[0]?.tenantId).not.toBe(first.tenants[0]?.tenantId);
    }
    await expect(store.listForAdmin({ cursor: "garbage" })).rejects.toThrow();
  });
});
