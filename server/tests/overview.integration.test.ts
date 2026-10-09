import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { CloudRates } from "../../shared/cloud-pricing";
import { createAccountStore } from "../src/accounts/store";
import { createCloudMeter } from "../src/cloud/meter";
import { createCloudStore } from "../src/cloud/store";
import { createDatabase } from "../src/db/client";
import {
  cloudCharges,
  cloudRates,
  marketplaceListings,
  marketplacePublishers,
  marketplaceReports,
  runSlots,
  tenantMemberships,
  tenants,
  users,
  workItems,
} from "../src/db/schema";
import type { DeploymentFacts } from "../src/overview/checks";
import type { Overview } from "../src/overview/routes";
import { adminOverviewRoutes } from "../src/overview/routes";
import { createOverviewStore } from "../src/overview/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The administrator's overview against a real database.
 *
 * What is protected: only staff can read it; it counts what is really there (and nothing it counts
 * names a person or an account); and each thing that needs a decision shows up as one.
 *
 * The database is shared with the other test files, so every figure is checked as a change from
 * what was there before the rows were added.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const cloudStore = createCloudStore(database);
const meter = createCloudMeter(database);

const facts: DeploymentFacts = {
  hosted: true,
  billing: { id: "paddle", environment: "test" },
  cloud: { mode: "metered", priced: false },
  termsAcceptance: "off",
  auditShipping: "off",
  metricsServed: false,
  contentSecurityPolicy: "report-only",
  appUrl: "https://app.example.com",
  oldEncryptionKeys: false,
  staffDirectory: true,
};

const requireUser: Parameters<typeof adminOverviewRoutes>[0]["requireUser"] =
  async (context, next) => {
    const as = context.req.header("x-as");
    if (!as) return context.json({ error: "Sign in" }, 401);
    const [id, role] = as.split(":");
    context.set("actor", {
      id: id as string,
      email: `${id}@example.com`,
      role: role === "admin" ? "admin" : "user",
    });
    await next();
  };

const app = new Hono().route(
  "/api/admin/overview",
  adminOverviewRoutes({
    requireUser,
    store: createOverviewStore(database),
    facts: () => facts,
    cloud: { mode: "metered", store: cloudStore, meter },
  }),
);

const read = async (as = "staff:admin") => {
  const response = await app.request("/api/admin/overview", {
    headers: { "x-as": as },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Overview;
};

const made: string[] = [];
const tenantsMade: string[] = [];
const listings: string[] = [];
const workKeys: string[] = [];
const slotRuns: string[] = [];
async function person(plan?: {
  planId: string;
  status: "active" | "past_due";
}) {
  const id = `ov-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  const tenantId = await accounts.ensureTenant(id);
  tenantsMade.push(tenantId);
  if (plan) {
    await accounts.applySubscription(tenantId, {
      ...plan,
      provider: "paddle",
    });
  }
  return { id, tenantId };
}

afterEach(async () => {
  for (const id of made.splice(0)) {
    const rows = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const row of rows)
      await database.delete(tenants).where(eq(tenants.id, row.tenantId));
  }
  tenantsMade.length = 0;
  if (workKeys.length > 0) {
    await database.delete(workItems).where(inArray(workItems.key, workKeys));
    workKeys.length = 0;
  }
  if (slotRuns.length > 0) {
    await database.delete(runSlots).where(inArray(runSlots.runId, slotRuns));
    slotRuns.length = 0;
  }
  if (listings.length > 0) {
    await database
      .delete(marketplacePublishers)
      .where(inArray(marketplacePublishers.displayName, listings));
    listings.length = 0;
  }
  await database.delete(cloudRates);
});
afterAll(async () => {
  await database.$client.close();
});

describe("who may read it", () => {
  test("nobody who is not signed in, and nobody who is not staff", async () => {
    expect((await app.request("/api/admin/overview")).status).toBe(401);
    const asPerson = await app.request("/api/admin/overview", {
      headers: { "x-as": "somebody:user" },
    });
    expect(asPerson.status).toBe(403);
    expect(await asPerson.text()).not.toContain("paying");
  });
});

describe("customers and money", () => {
  test("counts accounts by what they pay, and adds up the monthly recurring revenue at list price", async () => {
    const before = await read();
    await person({ planId: "agent", status: "active" });
    await person({ planId: "agent", status: "active" });
    await person({ planId: "team", status: "past_due" });
    const suspended = await person({ planId: "team", status: "active" });
    await accounts.suspend(suspended.tenantId, "Chargeback.");

    const after = await read();
    const change = (pick: (o: Overview) => number) =>
      pick(after) - pick(before);
    expect(change((o) => o.customers.accounts)).toBe(4);
    expect(change((o) => o.customers.newLast7Days)).toBe(4);
    expect(change((o) => o.customers.people)).toBe(4);
    // Two Ark Agent at €50 and one Ark Team at €100 that is paid up; the past-due one is not paying.
    expect(change((o) => o.customers.paying)).toBe(3);
    expect(change((o) => o.customers.pastDue)).toBe(1);
    expect(change((o) => o.customers.suspended)).toBe(1);
    expect(change((o) => o.revenue.monthlyRecurringCents)).toBe(
      2 * 5000 + 10000,
    );
    const agent = (o: Overview) =>
      o.customers.byPlan.find((plan) => plan.planId === "agent")?.paying ?? 0;
    expect(agent(after) - agent(before)).toBe(2);
    expect(after.attention.map((item) => item.id)).toContain(
      "accounts-past-due",
    );
    expect(after.attention.map((item) => item.id)).toContain(
      "accounts-suspended",
    );
  });

  test("an internal plan is never counted as revenue", async () => {
    const before = await read();
    await person({ planId: "internal", status: "active" });
    const after = await read();
    expect(after.revenue.monthlyRecurringCents).toBe(
      before.revenue.monthlyRecurringCents,
    );
    expect(after.customers.paying).toBe(before.customers.paying);
  });

  test("holds no name, address or account id", async () => {
    const ann = await person({ planId: "agent", status: "active" });
    const text = JSON.stringify(await read());
    expect(text).not.toContain(ann.id);
    expect(text).not.toContain(ann.tenantId);
    expect(text).not.toContain("@example.com");
  });
});

describe("what is happening now", () => {
  test("counts runs in progress and the accounts they belong to, not ones that expired", async () => {
    const before = await read();
    const ann = await person({ planId: "team", status: "active" });
    const live = Date.now() + 60_000;
    const rows = ["a", "b", "c"].map((suffix, index) => {
      const runId = `ov-run-${randomUUID()}-${suffix}`;
      slotRuns.push(runId);
      return {
        tenantId: ann.tenantId,
        botId: "bot",
        runId,
        userId: ann.id,
        expiresAt: new Date(index === 2 ? Date.now() - 60_000 : live),
      };
    });
    await database.insert(runSlots).values(rows);
    const after = await read();
    expect(after.now.runs - before.now.runs).toBe(2);
    expect(after.now.accounts - before.now.accounts).toBe(1);
  });

  test("a job that has run out of attempts is something to look at; one still waiting is just queued", async () => {
    const before = await read();
    const gone = `ov-gone-${randomUUID()}`;
    const waiting = `ov-wait-${randomUUID()}`;
    workKeys.push(gone, waiting);
    await database.insert(workItems).values([
      { kind: "overview.test", key: gone, attempts: 5, lastError: "boom" },
      { kind: "overview.test", key: waiting, attempts: 0 },
    ]);
    const after = await read();
    expect(after.now.queuedWork - before.now.queuedWork).toBe(1);
    expect(after.attention.map((item) => item.id)).toContain("work-gave-up");
  });
});

describe("what needs a decision", () => {
  test("shared coworkers waiting for review, and a report against one", async () => {
    const name = `ov-pub-${randomUUID()}`;
    listings.push(name);
    const [publisher] = await database
      .insert(marketplacePublishers)
      .values({ displayName: name })
      .returning({ id: marketplacePublishers.id });
    const [listing] = await database
      .insert(marketplaceListings)
      .values({
        kind: "shared",
        slug: `ov-${randomUUID()}`,
        publisherId: publisher?.id as string,
        title: "A coworker",
        summary: "Does a thing.",
        category: "other",
        content: {},
        status: "pending",
      })
      .returning({ id: marketplaceListings.id });
    const reporter = await person();
    await database.insert(marketplaceReports).values({
      listingId: listing?.id as string,
      reporterUserId: reporter.id,
      reason: "spam",
    });
    const ids = (await read()).attention.map((item) => item.id);
    expect(ids).toContain("marketplace-review");
    expect(ids).toContain("marketplace-reports");
  });

  test("a cloud charge nobody can say was taken, and one stuck while being sent", async () => {
    const ann = await person({ planId: "agent", status: "active" });
    const bob = await person({ planId: "agent", status: "active" });
    const rates: CloudRates = {
      computeCentsPerHour: 60,
      storageCentsPerGbMonth: 10,
      egressCentsPerGb: 5,
      paymentFeePercent: 5,
      paymentFeeFixedCents: 50,
      marginPercent: 0,
      minimumChargeCents: 500,
    };
    const usage = {
      computeSeconds: 3600,
      storageByteSeconds: 0,
      egressBytes: 0,
    };
    await database.insert(cloudCharges).values([
      {
        tenantId: ann.tenantId,
        period: "2026-09",
        status: "uncertain",
        usage,
        rates,
        costCents: "60",
        amountCents: 123,
      },
      {
        tenantId: bob.tenantId,
        period: "2026-09",
        status: "charging",
        usage,
        rates,
        costCents: "60",
        amountCents: 123,
        updatedAt: new Date(Date.now() - 2 * 3_600_000),
      },
    ]);
    const items = (await read()).attention;
    const ids = items.map((item) => item.id);
    expect(ids).toContain("charges-uncertain");
    expect(ids).toContain("charges-stuck");
    // A decision comes before a thing to watch.
    const firstWatch = items.findIndex((item) => item.severity === "watch");
    const lastAction = items.map((item) => item.severity).lastIndexOf("action");
    if (firstWatch !== -1) expect(lastAction).toBeLessThan(firstWatch);
  });
});

describe("cloud this month", () => {
  test("says whether anything has been priced, for the month it is", async () => {
    const unpriced = await read();
    expect(unpriced.cloud?.mode).toBe("metered");
    expect(unpriced.cloud?.priced).toBe(false);
    expect(unpriced.cloud?.period).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);

    const staff = await person();
    await cloudStore.setRates(
      {
        computeCentsPerHour: 60,
        storageCentsPerGbMonth: 10,
        egressCentsPerGb: 5,
        paymentFeePercent: 5,
        paymentFeeFixedCents: 50,
        marginPercent: 0,
        minimumChargeCents: 500,
      },
      staff.id,
    );
    expect((await read()).cloud?.priced).toBe(true);
  });
});

describe("the settings read back", () => {
  test("returns the go-live checks for the deployment's own settings", async () => {
    const checks = (await read()).checks;
    const payments = checks.find((check) => check.id === "payments");
    expect(payments?.state).toBe("todo");
    expect(payments?.detail).toContain("test mode");
  });
});
