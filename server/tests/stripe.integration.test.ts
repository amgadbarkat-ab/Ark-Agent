import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { accountRoutes } from "../src/accounts/routes";
import { createAccountStore } from "../src/accounts/store";
import { BillingUnavailableError } from "../src/billing/provider";
import { stripeBilling } from "../src/billing/stripe";
import { createBillingWebhook } from "../src/billing/webhook";
import { createDatabase } from "../src/db/client";
import {
  billingEvents,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A customer's whole life with Stripe: choose a plan, pay, be notified, renew, change plan, cancel,
 * and be notified twice or late. The database, the routes and the webhook handler are real; Stripe is
 * a fake that follows its published API and keeps each subscription's current state, which is what
 * the adapter asks for when a notice arrives. Notices are signed here with a test signing secret, the
 * way Stripe signs them. See stripe.test.ts for the adapter on its own.
 */

const SECRET = "whsec_integrationsecret01";
const NOW = 1_800_000_000_000;
const APP = "https://ark.example.test";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const made: string[] = [];
const stripeCalls: Array<{
  method: string;
  path: string;
  form: Record<string, string>;
}> = [];
/** Stripe's side: each subscription as it is now. */
const state = new Map<string, Record<string, unknown>>();
let stripeDown = false;
// Each reading of the clock is a millisecond later, as each question to Stripe is.
let clock = NOW;

const PRICES: Record<string, string> = {
  agent: "price_agent01",
  team: "price_team01",
  enterprise: "price_ent01",
};

const stripe = stripeBilling({
  secretKey: "sk_test_51integrationkey",
  webhookSecret: SECRET,
  prices: PRICES,
  now: () => {
    clock += 1;
    return clock;
  },
  fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (stripeDown) throw new TypeError("fetch failed");
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const form = Object.fromEntries(
      new URLSearchParams(init?.body ? String(init.body) : ""),
    );
    stripeCalls.push({ method, path, form });
    if (path === "/v1/checkout/sessions") {
      return Response.json({
        id: "cs_test_integration",
        url: "https://checkout.stripe.com/c/pay/cs_test_integration",
      });
    }
    if (path === "/v1/billing_portal/sessions") {
      return Response.json({
        url: "https://billing.stripe.com/p/session/test_integration",
      });
    }
    const id = /^\/v1\/subscriptions\/([^/]+)$/.exec(path)?.[1];
    const found = id ? state.get(id) : undefined;
    if (found) return Response.json(found);
    return Response.json(
      { error: { code: "resource_missing" } },
      { status: 404 },
    );
  }) as unknown as typeof fetch,
});

const applied: string[] = [];
const webhook = createBillingWebhook({
  database,
  accounts,
  providers: new Map([[stripe.id, stripe]]),
  onApplied: async ({ event }) => {
    applied.push(event.eventId);
  },
});

async function person() {
  const id = `stp-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return {
    id,
    email: `${id}@example.com`,
    tenantId: await accounts.ensureTenant(id),
    subscriptionId: `sub_${randomUUID().replaceAll("-", "")}`,
    customerId: `cus_${randomUUID().replaceAll("-", "")}`,
  };
}

afterEach(async () => {
  stripeCalls.length = 0;
  applied.length = 0;
  state.clear();
  stripeDown = false;
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
      billing: stripe,
      appUrl: APP,
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

/** Stripe's subscription for this person, as Stripe now holds it. */
function stripeHas(
  who: { tenantId: string; subscriptionId: string; customerId: string },
  overrides: { plan?: string; status?: string; periodEnd?: number } & Record<
    string,
    unknown
  > = {},
) {
  const { plan = "team", status = "active", periodEnd, ...rest } = overrides;
  state.set(who.subscriptionId, {
    id: who.subscriptionId,
    object: "subscription",
    customer: who.customerId,
    status,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { tenant_id: who.tenantId, plan_id: plan },
    items: {
      data: [
        {
          id: `si_${who.subscriptionId.slice(4, 14)}`,
          price: { id: PRICES[plan] },
          current_period_end: periodEnd ?? 1_802_592_000,
        },
      ],
    },
    ...rest,
  });
}

function notice(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${randomUUID().replaceAll("-", "")}`,
) {
  return {
    id,
    object: "event",
    created: Math.floor(NOW / 1000),
    livemode: false,
    type,
    data: { object },
  };
}

function subscriptionNotice(
  who: { subscriptionId: string },
  type = "customer.subscription.updated",
  object: Record<string, unknown> = {},
  id?: string,
) {
  return notice(
    type,
    { id: who.subscriptionId, object: "subscription", ...object },
    id,
  );
}

function deliver(event: unknown, secret = SECRET) {
  const raw = JSON.stringify(event);
  const t = Math.floor(NOW / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return webhook.handle(
    "stripe",
    new Headers({ "stripe-signature": `t=${t},v1=${v1}` }),
    raw,
  );
}

async function subscribed(plan = "team") {
  const ann = await person();
  stripeHas(ann, { plan });
  const outcome = await deliver(
    subscriptionNotice(ann, "customer.subscription.created"),
  );
  expect(outcome).toMatchObject({ ok: true, applied: 1 });
  stripeCalls.length = 0;
  return { ann, ...appFor(ann) };
}

describe("buying a plan", () => {
  test("asking to buy opens Stripe's checkout for this account and grants nothing; the completed checkout does", async () => {
    const ann = await person();
    const { app } = appFor(ann);
    const chosen = await call(app, "POST", "/api/account/plan", {
      planId: "team",
    });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_integration",
    );
    expect(stripeCalls).toHaveLength(1);
    expect(stripeCalls[0]).toMatchObject({
      method: "POST",
      path: "/v1/checkout/sessions",
      form: {
        mode: "subscription",
        "line_items[0][price]": "price_team01",
        client_reference_id: ann.tenantId,
        success_url: `${APP}/settings/plan?paid=1`,
        cancel_url: `${APP}/settings/plan`,
        "subscription_data[metadata][tenant_id]": ann.tenantId,
      },
    });
    // Going to the payment page is not paying.
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);

    // The customer pays; Stripe makes the subscription and says the checkout is complete.
    stripeHas(ann, { plan: "team" });
    const outcome = await deliver(
      notice("checkout.session.completed", {
        id: "cs_test_integration",
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: ann.tenantId,
        customer: ann.customerId,
        subscription: ann.subscriptionId,
      }),
    );
    expect(outcome).toMatchObject({ ok: true, applied: 1, ignored: 0 });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      planId: "team",
      canRun: true,
      maxActiveBots: 15,
    });
    expect(
      await accounts.providerSubscriptionIdFor(ann.tenantId, "stripe"),
    ).toBe(ann.subscriptionId);
    expect(await accounts.providerCustomerIdFor(ann.tenantId, "stripe")).toBe(
      ann.customerId,
    );
  });

  test("the same notice twice is acted on once", async () => {
    const ann = await person();
    stripeHas(ann);
    const event = subscriptionNotice(
      ann,
      "customer.subscription.created",
      {},
      "evt_stripe_repeat",
    );
    expect(await deliver(event)).toMatchObject({ applied: 1, duplicates: 0 });
    expect(await deliver(event)).toMatchObject({ applied: 0, duplicates: 1 });
    expect(applied).toEqual(["evt_stripe_repeat"]);
  });

  test("an unsigned or wrongly signed notice changes nothing and asks Stripe nothing", async () => {
    const ann = await person();
    stripeHas(ann);
    const event = subscriptionNotice(ann, "customer.subscription.created");
    expect(await deliver(event, "whsec_someoneelse")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await webhook.handle("stripe", new Headers(), JSON.stringify(event)),
    ).toMatchObject({ ok: false, status: 400 });
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
    expect(stripeCalls).toEqual([]);
  });

  test("a notice that arrives while Stripe cannot be asked is not recorded, so Stripe's retry applies it", async () => {
    const ann = await person();
    stripeHas(ann);
    const event = subscriptionNotice(ann, "customer.subscription.created");
    stripeDown = true;
    expect(await deliver(event).catch((error) => error)).toBeInstanceOf(
      BillingUnavailableError,
    );
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
    stripeDown = false;
    expect(await deliver(event)).toMatchObject({ applied: 1, duplicates: 0 });
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(true);
  });

  test("a notice for an account that does not exist, or none of ours, is recorded and ignored", async () => {
    const stranger = {
      tenantId: randomUUID(),
      subscriptionId: "sub_stranger01",
      customerId: "cus_nobodyknows01",
    };
    stripeHas(stranger);
    expect(await deliver(subscriptionNotice(stranger))).toMatchObject({
      ok: true,
      applied: 0,
      ignored: 1,
    });
  });
});

describe("renewal and notices out of order", () => {
  test("a renewal moves the end of the period", async () => {
    const { ann } = await subscribed();
    stripeHas(ann, { periodEnd: 1_805_270_400 });
    expect(await deliver(subscriptionNotice(ann))).toMatchObject({
      applied: 1,
    });
    expect((await accounts.summaryFor(ann.id)).currentPeriodEnd).toBe(
      new Date(1_805_270_400 * 1000).toISOString(),
    );
  });

  test("a late 'created' that carried 'incomplete' does not undo the payment that followed it", async () => {
    const { ann } = await subscribed();
    const late = await deliver(
      subscriptionNotice(ann, "customer.subscription.created", {
        status: "incomplete",
      }),
    );
    expect(late).toMatchObject({ ok: true });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      canRun: true,
      planId: "team",
    });
  });

  test("a cancellation ends the plan, and a late notice from before it does not bring it back", async () => {
    const { ann } = await subscribed();
    stripeHas(ann, { status: "canceled" });
    expect(
      await deliver(subscriptionNotice(ann, "customer.subscription.deleted")),
    ).toMatchObject({ applied: 1 });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      canRun: false,
      blockedCode: "canceled",
    });
    await deliver(
      subscriptionNotice(ann, "customer.subscription.updated", {
        status: "active",
      }),
    );
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
  });

  test("a late notice about a subscription the customer has since replaced does not end the new one", async () => {
    const { ann } = await subscribed();
    const first = { ...ann };
    stripeHas(first, { status: "canceled" });
    const ended = subscriptionNotice(first, "customer.subscription.deleted");
    await deliver(ended);
    // They buy again: a second subscription.
    const second = { ...ann, subscriptionId: `${ann.subscriptionId}x2` };
    stripeHas(second, { plan: "enterprise" });
    expect(
      await deliver(
        subscriptionNotice(second, "customer.subscription.created"),
      ),
    ).toMatchObject({ applied: 1 });
    // Stripe retries a notice about the first one, days late.
    expect(
      await deliver(subscriptionNotice(first, "customer.subscription.deleted")),
    ).toMatchObject({ ok: true, applied: 0, ignored: 1 });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      canRun: true,
      planId: "enterprise",
    });
    expect(
      await accounts.providerSubscriptionIdFor(ann.tenantId, "stripe"),
    ).toBe(second.subscriptionId);
  });

  test("a failed renewal keeps the account running and says so", async () => {
    const { ann } = await subscribed();
    stripeHas(ann, { status: "past_due" });
    await deliver(subscriptionNotice(ann));
    expect(await accounts.summaryFor(ann.id)).toMatchObject({
      subscriptionStatus: "past_due",
      canRun: true,
    });
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
    expect(stripeCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/subscriptions/${ann.subscriptionId}`,
      `POST /v1/subscriptions/${ann.subscriptionId}`,
    ]);
    expect(stripeCalls[1]?.form).toMatchObject({
      "items[0][price]": "price_ent01",
      proration_behavior: "always_invoice",
    });
    expect(audit.at(-1)).toMatchObject({
      eventType: "account.subscription_changed",
      payload: { change: "plan", from: "team", to: "enterprise" },
    });
    // The plan changes when Stripe says so, not when we asked.
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("team");
    stripeHas(ann, { plan: "enterprise" });
    await deliver(subscriptionNotice(ann));
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("enterprise");
  });

  test("somebody whose subscription ended buys a new one", async () => {
    const { ann, app } = await subscribed("team");
    stripeHas(ann, { status: "canceled" });
    await deliver(subscriptionNotice(ann, "customer.subscription.deleted"));
    stripeCalls.length = 0;
    const response = await call(app, "POST", "/api/account/plan", {
      planId: "agent",
    });
    expect((await response.json()).checkoutUrl).toContain(
      "checkout.stripe.com",
    );
    expect(stripeCalls.map((c) => c.path)).toEqual(["/v1/checkout/sessions"]);
  });

  test("an id that belongs to another provider is never sent to Stripe", async () => {
    const ann = await person();
    await accounts.applySubscription(ann.tenantId, {
      planId: "team",
      status: "active",
      provider: "paddle",
      providerCustomerId: "ctm_01paddle",
      providerSubscriptionId: "sub_01paddle",
    });
    const { app } = appFor(ann);
    const plan = await call(app, "POST", "/api/account/plan", {
      planId: "enterprise",
    });
    expect((await plan.json()).checkoutUrl).toContain("checkout.stripe.com");
    expect((await call(app, "POST", "/api/account/portal")).status).toBe(404);
    expect((await call(app, "POST", "/api/account/cancel")).status).toBe(400);
    expect(stripeCalls.map((c) => c.path)).toEqual(["/v1/checkout/sessions"]);
  });
});

describe("managing the subscription", () => {
  test("cancels at the end of the paid period, and the account says so", async () => {
    const { ann, app } = await subscribed();
    const response = await call(app, "POST", "/api/account/cancel");
    expect(response.status).toBe(200);
    expect(stripeCalls[0]).toEqual({
      method: "POST",
      path: `/v1/subscriptions/${ann.subscriptionId}`,
      form: { cancel_at_period_end: "true" },
    });
    expect(await accounts.summaryFor(ann.id)).toMatchObject({
      cancelAtPeriodEnd: true,
      canRun: true,
    });
    // Stripe's own notice agrees, and a later one that removes it (kept in the portal) is believed.
    stripeHas(ann, { cancel_at_period_end: true });
    await deliver(subscriptionNotice(ann));
    expect((await accounts.summaryFor(ann.id)).cancelAtPeriodEnd).toBe(true);
    stripeHas(ann);
    await deliver(subscriptionNotice(ann));
    expect((await accounts.summaryFor(ann.id)).cancelAtPeriodEnd).toBe(false);
  });

  test("opens Stripe's billing portal for the customer", async () => {
    const { ann, app } = await subscribed();
    const response = await call(app, "POST", "/api/account/portal");
    expect(response.status).toBe(200);
    expect((await response.json()).portalUrl).toBe(
      "https://billing.stripe.com/p/session/test_integration",
    );
    expect(stripeCalls[0]).toMatchObject({
      path: "/v1/billing_portal/sessions",
      form: { customer: ann.customerId, return_url: `${APP}/settings/plan` },
    });
  });

  test("a failing Stripe is a sentence to the customer, not a server error", async () => {
    const { app } = await subscribed();
    stripeDown = true;
    for (const [path, body] of [
      ["/api/account/plan", { planId: "enterprise" }],
      ["/api/account/portal", undefined],
      ["/api/account/cancel", undefined],
    ] as const) {
      const response = await call(app, "POST", path, body);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).not.toMatch(
        /fetch failed/,
      );
    }
  });
});
