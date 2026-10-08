import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { accountRoutes } from "../src/accounts/routes";
import { createAccountStore } from "../src/accounts/store";
import { paddleBilling } from "../src/billing/paddle";
import { createBillingWebhook } from "../src/billing/webhook";
import { createDatabase } from "../src/db/client";
import {
  billingEvents,
  subscriptions,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A customer's whole life with Paddle: choose a plan, pay, be notified, change plan, cancel, and be
 * notified out of order. The database and the routes are real; Paddle is a fake that follows its
 * published API. See paddle.test.ts for the adapter on its own.
 */

const SECRET = "pdl_ntfset_01integrationsecret";
const NOW = 1_800_000_000_000;
const CHECKOUT = "https://ark.example.test/api/billing/checkout";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const made: string[] = [];
const paddleCalls: Array<{ method: string; path: string; body: unknown }> = [];

const paddle = paddleBilling({
  apiKey: "pdl_sdbx_apikey_01testkey",
  webhookSecret: SECRET,
  clientToken: "test_1234567890abcdef",
  environment: "sandbox",
  prices: { agent: "pri_agent", team: "pri_team", enterprise: "pri_ent" },
  checkoutUrl: CHECKOUT,
  now: () => NOW,
  fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    paddleCalls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/transactions") {
      return Response.json(
        { data: { checkout: { url: `${body.checkout.url}?_ptxn=txn_01abc` } } },
        { status: 201 },
      );
    }
    if (path.endsWith("/portal-sessions")) {
      return Response.json(
        {
          data: {
            urls: {
              general: { overview: "https://customer-portal.paddle.com/x" },
            },
          },
        },
        { status: 201 },
      );
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch,
});

const applied: string[] = [];
const webhook = createBillingWebhook({
  database,
  accounts,
  providers: new Map([[paddle.id, paddle]]),
  onApplied: async ({ event }) => {
    applied.push(event.eventId);
  },
});

async function person() {
  const id = `pdl-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return {
    id,
    email: `${id}@example.com`,
    tenantId: await accounts.ensureTenant(id),
  };
}

afterEach(async () => {
  paddleCalls.length = 0;
  applied.length = 0;
  for (const id of made.splice(0)) {
    const rows = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const row of rows) {
      await database
        .delete(billingEvents)
        .where(eq(billingEvents.tenantId, row.tenantId));
      await database.delete(tenants).where(eq(tenants.id, row.tenantId));
    }
  }
});
afterAll(async () => {
  await database.$client.close();
});

function appFor(who: { id: string; email: string }) {
  const audit: Array<{ eventType: string; payload: unknown }> = [];
  const app = new Hono().route(
    "/api/account",
    accountRoutes({
      requireUser: async (context, next) => {
        context.set("actor", { id: who.id, email: who.email, role: "user" });
        await next();
      },
      accounts,
      billing: paddle,
      appUrl: "https://ark.example.test",
      audit: async (event) => {
        audit.push(event);
      },
    }),
  );
  return { app, audit };
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let counter = 0;
function notice(
  tenantId: string | undefined,
  overrides: {
    type?: string;
    status?: string;
    price?: string;
    at?: string;
    id?: string;
    scheduled?: unknown;
    subscription?: string;
    customer?: string;
  } = {},
) {
  counter += 1;
  return {
    event_id: overrides.id ?? `evt_${randomUUID().replaceAll("-", "")}`,
    event_type: overrides.type ?? "subscription.updated",
    occurred_at:
      overrides.at ??
      `2026-10-08T10:00:00.${String(counter).padStart(6, "0")}Z`,
    notification_id: `ntf_${counter}`,
    data: {
      id: overrides.subscription ?? "sub_01integration",
      status: overrides.status ?? "active",
      customer_id: overrides.customer ?? "ctm_01integration",
      ...(tenantId ? { custom_data: { tenant_id: tenantId } } : {}),
      current_billing_period: {
        starts_at: "2026-10-08T10:00:00Z",
        ends_at: "2026-11-08T10:00:00Z",
      },
      scheduled_change: overrides.scheduled ?? null,
      items: [{ price: { id: overrides.price ?? "pri_team" } }],
    },
  };
}

function deliver(event: unknown, secret = SECRET) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(NOW / 1000);
  const h1 = createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex");
  return webhook.handle(
    "paddle",
    new Headers({ "paddle-signature": `ts=${ts};h1=${h1}` }),
    raw,
  );
}

async function subscribed(plan = "team") {
  const ann = await person();
  const outcome = await deliver(
    notice(ann.tenantId, {
      type: "subscription.created",
      price: `pri_${plan === "enterprise" ? "ent" : plan}`,
    }),
  );
  expect(outcome).toMatchObject({ ok: true, applied: 1 });
  return { ann, ...appFor(ann) };
}

describe("buying a plan", () => {
  test("asking to buy opens a checkout for this account and grants nothing; the payment notice does", async () => {
    const ann = await person();
    const { app } = appFor(ann);
    const chosen = await call(app, "POST", "/api/account/plan", {
      planId: "team",
    });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).checkoutUrl).toBe(
      `${CHECKOUT}?_ptxn=txn_01abc`,
    );
    expect(paddleCalls).toEqual([
      {
        method: "POST",
        path: "/transactions",
        body: {
          items: [{ price_id: "pri_team", quantity: 1 }],
          custom_data: { tenant_id: ann.tenantId, plan_id: "team" },
          checkout: { url: CHECKOUT },
        },
      },
    ]);
    // Going to the payment page is not paying.
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);

    const outcome = await deliver(
      notice(ann.tenantId, { type: "subscription.created" }),
    );
    expect(outcome).toMatchObject({ ok: true, applied: 1, ignored: 0 });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      planId: "team",
      canRun: true,
      maxActiveBots: 15,
    });
    expect(
      await accounts.providerSubscriptionIdFor(ann.tenantId, "paddle"),
    ).toBe("sub_01integration");
    expect(await accounts.providerCustomerIdFor(ann.tenantId, "paddle")).toBe(
      "ctm_01integration",
    );
  });

  test("a later notice that names only the customer still finds the account", async () => {
    const { ann } = await subscribed();
    const outcome = await deliver(
      notice(undefined, { type: "subscription.updated", price: "pri_ent" }),
    );
    expect(outcome).toMatchObject({ ok: true, applied: 1 });
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("enterprise");
  });

  test("an unsigned, wrongly signed or stale notice changes nothing", async () => {
    const ann = await person();
    const event = notice(ann.tenantId, { type: "subscription.created" });
    expect(await deliver(event, "pdl_ntfset_someone_else")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await webhook.handle("paddle", new Headers(), JSON.stringify(event)),
    ).toMatchObject({ ok: false, status: 400 });
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
  });

  test("a notice for an account that does not exist, or none of ours, is recorded and ignored", async () => {
    expect(await deliver(notice(randomUUID()))).toMatchObject({
      ok: true,
      applied: 0,
      ignored: 1,
    });
    expect(
      await deliver(notice(undefined, { customer: "ctm_nobody_knows" })),
    ).toMatchObject({ ok: true, applied: 0, ignored: 1 });
  });

  test("the same notice twice is acted on once", async () => {
    const ann = await person();
    const event = notice(ann.tenantId, {
      type: "subscription.created",
      id: "evt_repeat",
    });
    expect(await deliver(event)).toMatchObject({ applied: 1, duplicates: 0 });
    expect(await deliver(event)).toMatchObject({ applied: 0, duplicates: 1 });
  });
});

describe("notices that arrive out of order", () => {
  test("an older one never undoes a newer one, to the microsecond", async () => {
    const { ann } = await subscribed();
    // Paddle cancels, and the notice about the renewal before it limps in afterwards.
    const cancelled = await deliver(
      notice(ann.tenantId, {
        type: "subscription.canceled",
        status: "canceled",
        at: "2026-10-09T10:00:00.000002Z",
      }),
    );
    expect(cancelled).toMatchObject({ applied: 1 });
    const late = await deliver(
      notice(ann.tenantId, {
        type: "subscription.updated",
        status: "active",
        at: "2026-10-09T10:00:00.000001Z",
      }),
    );
    expect(late).toMatchObject({ ok: true, applied: 0, ignored: 1 });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      canRun: false,
      blockedCode: "canceled",
    });
    // A genuinely later one (they pay again) still goes through.
    const again = await deliver(
      notice(ann.tenantId, {
        type: "subscription.activated",
        status: "active",
        at: "2026-10-09T10:00:00.000003Z",
      }),
    );
    expect(again).toMatchObject({ applied: 1 });
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(true);
  });

  test("a stale notice does not count as applied, and is not audited as a change", async () => {
    const { ann } = await subscribed();
    await deliver(notice(ann.tenantId, { at: "2026-10-09T10:00:00.500000Z" }));
    const before = applied.length;
    const stale = notice(ann.tenantId, {
      status: "canceled",
      at: "2026-10-09T10:00:00.400000Z",
    });
    const outcome = await deliver(stale);
    expect(outcome).toMatchObject({ applied: 0, ignored: 1 });
    // Nothing downstream (the audit trail) is told it changed anything.
    expect(applied).toHaveLength(before);
    expect(applied).not.toContain(stale.event_id);
    const [row] = await database
      .select({ lastEventAt: subscriptions.lastEventAt })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, ann.tenantId));
    expect(row?.lastEventAt).toContain(".5");
  });
});

describe("changing plan while subscribed", () => {
  test("moves the subscription that exists instead of selling a second one", async () => {
    const { ann, app, audit } = await subscribed("team");
    const response = await call(app, "POST", "/api/account/plan", {
      planId: "enterprise",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: true });
    // No new transaction; the one subscription was changed, and charged now because it costs more.
    expect(paddleCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /subscriptions/sub_01integration",
    ]);
    expect(paddleCalls[0]?.body).toEqual({
      items: [{ price_id: "pri_ent", quantity: 1 }],
      proration_billing_mode: "prorated_immediately",
    });
    expect(audit.at(-1)).toMatchObject({
      eventType: "account.subscription_changed",
      payload: { change: "plan", from: "team", to: "enterprise" },
    });
    // The plan changes when Paddle says so, not when we asked.
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("team");
    await deliver(
      notice(ann.tenantId, { type: "subscription.updated", price: "pri_ent" }),
    );
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("enterprise");
  });

  test("a downgrade is settled at the next renewal", async () => {
    const { app } = await subscribed("team");
    await call(app, "POST", "/api/account/plan", { planId: "agent" });
    expect(paddleCalls[0]?.body).toMatchObject({
      proration_billing_mode: "prorated_next_billing_period",
    });
  });

  test("choosing the plan they are on, or changing while a payment has failed, is refused with a reason", async () => {
    const { ann, app } = await subscribed("team");
    const same = await call(app, "POST", "/api/account/plan", {
      planId: "team",
    });
    expect(same.status).toBe(409);
    expect((await same.json()).error).toMatch(/already on that plan/);

    await deliver(notice(ann.tenantId, { status: "past_due" }));
    const failed = await call(app, "POST", "/api/account/plan", {
      planId: "enterprise",
    });
    expect(failed.status).toBe(409);
    expect((await failed.json()).error).toMatch(/payment did not go through/);
    expect(paddleCalls).toEqual([]);
  });

  test("somebody whose subscription ended buys a new one", async () => {
    const { ann, app } = await subscribed("team");
    await deliver(
      notice(ann.tenantId, {
        type: "subscription.canceled",
        status: "canceled",
      }),
    );
    const response = await call(app, "POST", "/api/account/plan", {
      planId: "agent",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).checkoutUrl).toContain("_ptxn=");
    expect(paddleCalls.map((c) => c.path)).toEqual(["/transactions"]);
  });

  test("an id that belongs to another provider is never sent to Paddle", async () => {
    const ann = await person();
    await accounts.applySubscription(ann.tenantId, {
      planId: "team",
      status: "active",
      provider: "sandbox",
      providerCustomerId: "sandbox-customer-1",
      providerSubscriptionId: "sandbox-subscription-1",
    });
    const { app } = appFor(ann);
    // A new purchase, because the existing subscription is not Paddle's to change.
    const plan = await call(app, "POST", "/api/account/plan", {
      planId: "enterprise",
    });
    expect((await plan.json()).checkoutUrl).toContain("_ptxn=");
    expect((await call(app, "POST", "/api/account/portal")).status).toBe(404);
    expect((await call(app, "POST", "/api/account/cancel")).status).toBe(400);
    expect(paddleCalls.map((c) => c.path)).toEqual(["/transactions"]);
  });
});

describe("managing the subscription", () => {
  test("cancels at the end of the paid period, and the account says so", async () => {
    const { ann, app } = await subscribed();
    const response = await call(app, "POST", "/api/account/cancel");
    expect(response.status).toBe(200);
    expect(paddleCalls[0]).toEqual({
      method: "POST",
      path: "/subscriptions/sub_01integration/cancel",
      body: { effective_from: "next_billing_period" },
    });
    const summary = await accounts.summaryFor(ann.id);
    expect(summary).toMatchObject({ cancelAtPeriodEnd: true, canRun: true });
    // Paddle's own notice agrees, and a later one that removes it is believed too.
    await deliver(
      notice(ann.tenantId, {
        scheduled: { action: "cancel", effective_at: "2026-11-08T10:00:00Z" },
      }),
    );
    expect((await accounts.summaryFor(ann.id)).cancelAtPeriodEnd).toBe(true);
    await deliver(notice(ann.tenantId, { scheduled: null }));
    expect((await accounts.summaryFor(ann.id)).cancelAtPeriodEnd).toBe(false);
  });

  test("opens Paddle's own billing page for the customer", async () => {
    const { app } = await subscribed();
    const response = await call(app, "POST", "/api/account/portal");
    expect(response.status).toBe(200);
    expect((await response.json()).portalUrl).toBe(
      "https://customer-portal.paddle.com/x",
    );
    expect(paddleCalls[0]?.path).toBe(
      "/customers/ctm_01integration/portal-sessions",
    );
  });

  test("a failing Paddle is a sentence to the customer, not a server error", async () => {
    const down = paddleBilling({
      apiKey: "pdl_sdbx_apikey_01testkey",
      webhookSecret: SECRET,
      clientToken: "test_1234567890abcdef",
      environment: "sandbox",
      prices: { agent: "pri_agent", team: "pri_team", enterprise: "pri_ent" },
      checkoutUrl: CHECKOUT,
      fetchImpl: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    const ann = await person();
    await accounts.applySubscription(ann.tenantId, {
      planId: "team",
      status: "active",
      provider: "paddle",
      providerCustomerId: "ctm_01down",
      providerSubscriptionId: "sub_01down",
    });
    const app = new Hono().route(
      "/api/account",
      accountRoutes({
        requireUser: async (context, next) => {
          context.set("actor", { id: ann.id, email: ann.email, role: "user" });
          await next();
        },
        accounts,
        billing: down,
        appUrl: "https://ark.example.test",
      }),
    );
    for (const [path, body] of [
      ["/api/account/plan", { planId: "enterprise" }],
      ["/api/account/portal", undefined],
      ["/api/account/cancel", undefined],
    ] as const) {
      const response = await call(app, "POST", path, body);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).not.toMatch(
        /500|nope/,
      );
    }
  });
});
