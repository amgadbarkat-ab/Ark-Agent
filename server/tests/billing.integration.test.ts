import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { accountRoutes, adminAccountRoutes } from "../src/accounts/routes";
import { createAccountStore } from "../src/accounts/store";
import { manualBilling } from "../src/billing/manual";
import { billingFromEnvironment } from "../src/billing/select";
import {
  SANDBOX_SIGNATURE_HEADER,
  sandboxBilling,
  signSandboxBody,
} from "../src/billing/sandbox";
import { sandboxCheckoutRoutes } from "../src/billing/sandbox-routes";
import { createBillingWebhook } from "../src/billing/webhook";
import { createDatabase } from "../src/db/client";
import {
  billingEvents,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const SECRET = "sandbox-secret-for-this-test";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const sandbox = sandboxBilling({
  secret: SECRET,
  checkoutBase: "https://ark.test/billing/sandbox",
});
const webhook = createBillingWebhook({
  database,
  accounts,
  providers: new Map([[sandbox.id, sandbox]]),
});
const made: string[] = [];

async function person(label = "bill") {
  const id = `${label}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return {
    id,
    email: `${id}@example.com`,
    tenantId: await accounts.ensureTenant(id),
  };
}

afterEach(async () => {
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

const deliver = (events: unknown, signWith = SECRET) => {
  const body = JSON.stringify(events);
  return webhook.handle(
    "sandbox",
    new Headers({
      [SANDBOX_SIGNATURE_HEADER]: signSandboxBody(signWith, body),
    }),
    body,
  );
};

describe("a notification from the payment provider", () => {
  test("activates the plan that was paid for", async () => {
    const ann = await person();
    const outcome = await deliver([
      {
        eventId: `evt-${randomUUID()}`,
        type: "subscription.updated",
        tenantId: ann.tenantId,
        customerId: "cus_1",
        subscriptionId: "sub_1",
        planId: "team",
        status: "active",
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
      },
    ]);
    expect(outcome).toMatchObject({ ok: true, applied: 1, duplicates: 0 });
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      planId: "team",
      canRun: true,
      maxActiveBots: 15,
    });
    expect(await accounts.providerSubscriptionIdFor(ann.tenantId)).toBe(
      "sub_1",
    );
  });

  test("is acted on once, however many times the provider sends it", async () => {
    const ann = await person();
    const event = {
      eventId: `evt-${randomUUID()}`,
      type: "subscription.updated",
      tenantId: ann.tenantId,
      planId: "agent",
      status: "active",
    };
    expect(await deliver([event])).toMatchObject({ applied: 1 });
    await accounts.applySubscription(ann.tenantId, { planId: "enterprise" });
    // A late retry of the older event must not undo the newer change.
    expect(await deliver([event])).toMatchObject({ applied: 0, duplicates: 1 });
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("enterprise");
  });

  test("is found by the provider's customer id when it does not carry ours", async () => {
    const ann = await person();
    await deliver([
      {
        eventId: `evt-${randomUUID()}`,
        type: "checkout.completed",
        tenantId: ann.tenantId,
        customerId: "cus_find_me",
        planId: "agent",
        status: "active",
      },
    ]);
    const later = await deliver([
      {
        eventId: `evt-${randomUUID()}`,
        type: "payment.failed",
        customerId: "cus_find_me",
        status: "past_due",
      },
    ]);
    expect(later).toMatchObject({ applied: 1 });
    expect((await accounts.summaryFor(ann.id)).subscriptionStatus).toBe(
      "past_due",
    );
  });

  test("is refused when the signature is wrong, and changes nothing", async () => {
    const ann = await person();
    const outcome = await deliver(
      [
        {
          eventId: `evt-${randomUUID()}`,
          type: "subscription.updated",
          tenantId: ann.tenantId,
          planId: "enterprise",
          status: "active",
        },
      ],
      "the-wrong-secret-entirely",
    );
    expect(outcome).toMatchObject({ ok: false, status: 400 });
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
  });

  test("is refused when the body was altered after it was signed", async () => {
    const ann = await person();
    const signed = JSON.stringify([
      {
        eventId: "e1",
        tenantId: ann.tenantId,
        planId: "agent",
        status: "active",
      },
    ]);
    const tampered = signed.replace('"agent"', '"enterprise"');
    const outcome = await webhook.handle(
      "sandbox",
      new Headers({
        [SANDBOX_SIGNATURE_HEADER]: signSandboxBody(SECRET, signed),
      }),
      tampered,
    );
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });

  test("is refused from a provider that is not configured", async () => {
    expect(await webhook.handle("stripe", new Headers(), "{}")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test("naming a plan we do not sell, an account that is not ours, or no id at all is ignored, not retried", async () => {
    const ann = await person();
    const outcome = await deliver([
      {
        eventId: `e-${randomUUID()}`,
        tenantId: ann.tenantId,
        planId: "platinum",
        status: "active",
      },
      {
        eventId: `e-${randomUUID()}`,
        tenantId: randomUUID(),
        planId: "agent",
        status: "active",
      },
      {
        eventId: `e-${randomUUID()}`,
        tenantId: ann.tenantId,
        status: "exploded",
      },
      {
        type: "no-id",
        tenantId: ann.tenantId,
        planId: "agent",
        status: "active",
      },
    ]);
    expect(outcome).toMatchObject({ ok: true, applied: 0, ignored: 4 });
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
  });

  test("a failure while applying it leaves it unrecorded, so the provider's retry gets another go", async () => {
    const ann = await person();
    const failing = createBillingWebhook({
      database,
      accounts: {
        ...accounts,
        applySubscription: async () => {
          throw new Error("database went away");
        },
      },
      providers: new Map([[sandbox.id, sandbox]]),
    });
    const eventId = `evt-${randomUUID()}`;
    const body = JSON.stringify([
      { eventId, tenantId: ann.tenantId, planId: "agent", status: "active" },
    ]);
    const headers = new Headers({
      [SANDBOX_SIGNATURE_HEADER]: signSandboxBody(SECRET, body),
    });
    await expect(failing.handle("sandbox", headers, body)).rejects.toThrow(
      "went away",
    );
    // The retry, against a working database, now succeeds.
    expect(await webhook.handle("sandbox", headers, body)).toMatchObject({
      applied: 1,
    });
  });
});

describe("the sandbox payment page", () => {
  const appFor2 = (who: { id: string; email: string }) =>
    new Hono().route(
      "/api/billing/sandbox",
      sandboxCheckoutRoutes({
        requireUser: async (context, next) => {
          context.set("actor", { id: who.id, email: who.email, role: "user" });
          await next();
        },
        accounts,
        appUrl: "https://ark.test",
      }),
    );

  test("marks the caller's own account as paid and sends them back to the plan page", async () => {
    const ann = await person();
    const response = await appFor2(ann).request(
      `/api/billing/sandbox/checkout?plan=team&tenant=${ann.tenantId}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://ark.test/settings/plan",
    );
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      planId: "team",
      canRun: true,
    });
  });

  test("will not pay for somebody else's account or for a plan that is not sold", async () => {
    const ann = await person();
    const bob = await person();
    const app = appFor2(ann);
    expect(
      (
        await app.request(
          `/api/billing/sandbox/checkout?plan=team&tenant=${bob.tenantId}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/api/billing/sandbox/checkout?plan=internal&tenant=${ann.tenantId}`,
        )
      ).status,
    ).toBe(400);
    expect((await accounts.entitlementFor(bob.id)).canRun).toBe(false);
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
  });
});

describe("choosing a provider", () => {
  test("manual is the default, and the sandbox refuses to start half-configured or in production", () => {
    expect(billingFromEnvironment({}, { appUrl: undefined }).id).toBe("manual");
    expect(() =>
      billingFromEnvironment(
        { ARK_BILLING_PROVIDER: "sandbox" },
        { appUrl: undefined },
      ),
    ).toThrow(/ARK_BILLING_SANDBOX_SECRET/);
    expect(() =>
      billingFromEnvironment(
        {
          ARK_BILLING_PROVIDER: "sandbox",
          ARK_BILLING_SANDBOX_SECRET: "x".repeat(20),
          NODE_ENV: "production",
        },
        { appUrl: undefined },
      ),
    ).toThrow(/production/);
    expect(() =>
      billingFromEnvironment(
        { ARK_BILLING_PROVIDER: "mystery" },
        { appUrl: undefined },
      ),
    ).toThrow(/not a billing provider/);
  });
});

function appFor(
  who: { id: string; email: string } | null,
  options: {
    role?: "admin" | "user";
    provider?: typeof sandbox;
    mode?: "internal" | "subscriptions";
  } = {},
) {
  const store = options.mode
    ? createAccountStore(database, { billingMode: options.mode })
    : accounts;
  const events: Array<{ eventType: string; tenantId: string }> = [];
  const requireUser: Parameters<typeof accountRoutes>[0]["requireUser"] =
    async (context, next) => {
      if (!who) return context.json({ error: "Sign in" }, 401);
      context.set("actor", {
        id: who.id,
        email: who.email,
        role: options.role ?? "user",
      });
      await next();
    };
  const app = new Hono()
    .route(
      "/api/account",
      accountRoutes({
        requireUser,
        accounts: store,
        billing: options.provider ?? sandbox,
        appUrl: "https://ark.test",
        audit: async (event) => {
          events.push(event);
        },
      }),
    )
    .route(
      "/api/admin/accounts",
      adminAccountRoutes({
        requireUser,
        accounts: store,
        audit: async (event) => {
          events.push(event);
        },
      }),
    );
  return { app, events };
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("a customer's account", () => {
  test("shows what they have, what it allows, and the plans on offer", async () => {
    const ann = await person();
    const { app } = appFor(ann);
    const body = await (await call(app, "GET", "/api/account")).json();
    expect(body.account).toMatchObject({
      planId: "agent",
      canRun: false,
      blockedCode: "no_plan",
      activeBots: 0,
    });
    expect(body.billing).toMatchObject({
      mode: "subscriptions",
      provider: "sandbox",
      selfService: true,
    });
    expect(body.plans.map((p: { id: string }) => p.id)).toEqual([
      "agent",
      "team",
      "enterprise",
    ]);
  });

  test("signs up end to end: choose a plan, pay, and start working", async () => {
    const ann = await person();
    const { app } = appFor(ann);
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);

    const chosen = await call(app, "POST", "/api/account/plan", {
      planId: "team",
    });
    expect(chosen.status).toBe(200);
    const { checkoutUrl } = await chosen.json();
    const url = new URL(checkoutUrl);
    expect(url.searchParams.get("plan")).toBe("team");
    expect(url.searchParams.get("tenant")).toBe(ann.tenantId);

    // The customer pays; the provider notifies us.
    await deliver([
      {
        eventId: `evt-${randomUUID()}`,
        type: "checkout.completed",
        tenantId: ann.tenantId,
        customerId: "cus_e2e",
        subscriptionId: "sub_e2e",
        planId: "team",
        status: "active",
      },
    ]);
    const after = await (await call(app, "GET", "/api/account")).json();
    expect(after.account).toMatchObject({
      planId: "team",
      canRun: true,
      maxActiveBots: 15,
    });
  });

  test("refuses a plan that is not for sale, and anything else", async () => {
    const ann = await person();
    const { app } = appFor(ann);
    for (const body of [
      { planId: "internal" },
      { planId: "platinum" },
      {},
      { planId: "team", extra: 1 },
    ]) {
      expect((await call(app, "POST", "/api/account/plan", body)).status).toBe(
        400,
      );
    }
  });

  test("without a payment provider, says so instead of pretending", async () => {
    const ann = await person();
    const { app } = appFor(ann, { provider: manualBilling as never });
    const response = await call(app, "POST", "/api/account/plan", {
      planId: "agent",
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/contact us/i);
  });

  test("on an internal deployment there are no plans to choose", async () => {
    const ann = await person();
    const { app } = appFor(ann, { mode: "internal" });
    expect(
      (await call(app, "POST", "/api/account/plan", { planId: "agent" }))
        .status,
    ).toBe(400);
  });

  test("cancels at the end of the period, and records it", async () => {
    const ann = await person();
    await deliver([
      {
        eventId: `e-${randomUUID()}`,
        tenantId: ann.tenantId,
        subscriptionId: "sub_c",
        customerId: "cus_c",
        planId: "agent",
        status: "active",
      },
    ]);
    const { app, events } = appFor(ann);
    const response = await call(app, "POST", "/api/account/cancel");
    expect(response.status).toBe(200);
    expect((await accounts.summaryFor(ann.id)).cancelAtPeriodEnd).toBe(true);
    expect(events.map((e) => e.eventType)).toEqual([
      "account.subscription_changed",
    ]);
  });

  test("needs a signed-in person", async () => {
    const { app } = appFor(null);
    expect((await call(app, "GET", "/api/account")).status).toBe(401);
  });
});

describe("our staff's view of accounts", () => {
  test("is for administrators only", async () => {
    const ann = await person();
    const { app } = appFor(ann, { role: "user" });
    for (const [method, path, body] of [
      ["GET", "/api/admin/accounts"],
      ["PUT", `/api/admin/accounts/${ann.tenantId}/plan`, { planId: "team" }],
      ["POST", `/api/admin/accounts/${ann.tenantId}/suspend`, { reason: "x" }],
      ["POST", `/api/admin/accounts/${ann.tenantId}/resume`],
    ] as const) {
      expect((await call(app, method, path, body)).status).toBe(403);
    }
    expect((await accounts.entitlementFor(ann.id)).planId).toBe("agent");
  });

  test("sets a plan by hand, suspends and resumes, each on the audit trail", async () => {
    const ann = await person();
    const staff = await person("staff");
    const { app, events } = appFor(staff, { role: "admin" });

    expect(
      (
        await call(app, "PUT", `/api/admin/accounts/${ann.tenantId}/plan`, {
          planId: "enterprise",
        })
      ).status,
    ).toBe(200);
    expect(await accounts.entitlementFor(ann.id)).toMatchObject({
      planId: "enterprise",
      canRun: true,
    });

    expect(
      (
        await call(app, "POST", `/api/admin/accounts/${ann.tenantId}/suspend`, {
          reason: "chargeback",
        })
      ).status,
    ).toBe(200);
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(false);
    expect(
      (await call(app, "POST", `/api/admin/accounts/${ann.tenantId}/resume`))
        .status,
    ).toBe(200);
    expect((await accounts.entitlementFor(ann.id)).canRun).toBe(true);

    expect(events.map((e) => e.eventType)).toEqual([
      "account.plan_changed",
      "account.suspended",
      "account.resumed",
    ]);
    expect(events.every((e) => e.tenantId === ann.tenantId)).toBe(true);
  });

  test("lists accounts with their plan and usage, and says no to an account that does not exist", async () => {
    const ann = await person("listed");
    const staff = await person("staff");
    const { app } = appFor(staff, { role: "admin" });
    const list = await (
      await call(
        app,
        "GET",
        `/api/admin/accounts?search=${encodeURIComponent(ann.id)}`,
      )
    ).json();
    expect(list.tenants).toHaveLength(1);
    expect(list.tenants[0]).toMatchObject({
      planId: "agent",
      activeBots: 0,
      suspended: false,
    });
    expect(
      (
        await call(app, "PUT", `/api/admin/accounts/${randomUUID()}/plan`, {
          planId: "team",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(app, "GET", "/api/admin/accounts?limit=abc")).status,
    ).toBe(400);
    expect(
      (await call(app, "GET", "/api/admin/accounts?cursor=garbage")).status,
    ).toBe(400);
  });
});
