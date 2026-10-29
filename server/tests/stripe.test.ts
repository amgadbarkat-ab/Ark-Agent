import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { billingFromEnvironment } from "../src/billing/select";
import {
  formEncode,
  STRIPE_API_VERSION,
  type StripeConfig,
  statusFromStripe,
  stripeBilling,
  stripeConfigProblems,
} from "../src/billing/stripe";
import {
  BillingSignatureError,
  BillingUnavailableError,
} from "../src/billing/provider";
import { setupStripe, tryStripeCheckout } from "../src/billing/stripe-setup";

/**
 * Stripe as a payment provider, against a fake Stripe that follows its published API. Nothing here
 * reaches Stripe: the request shapes, the signature scheme (HMAC-SHA256 of `<t>.<raw body>` under the
 * endpoint's signing secret) and the object fields are the documented ones. The notifications are
 * signed here with a test signing secret, the way Stripe signs them.
 */

const SECRET = "whsec_testsigningsecret01";
const TENANT = "11111111-2222-4333-8444-555555555555";
const NOW = 1_800_000_000_000;
const RETURN = "https://ark.example.test/settings/plan";

const baseConfig: StripeConfig = {
  secretKey: "sk_test_51testkeyvalue",
  webhookSecret: SECRET,
  prices: {
    agent: "price_agent01",
    team: "price_team01",
    enterprise: "price_ent01",
  },
  now: () => NOW,
};

type Call = {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  form: URLSearchParams;
};

type FakeSubscription = Record<string, unknown>;

function stripeSubscription(
  overrides: Record<string, unknown> = {},
): FakeSubscription {
  return {
    id: "sub_1abc",
    object: "subscription",
    customer: "cus_1abc",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { tenant_id: TENANT, plan_id: "team" },
    items: {
      object: "list",
      data: [
        {
          id: "si_1abc",
          price: { id: "price_team01" },
          quantity: 1,
          current_period_end: 1_802_592_000,
        },
      ],
    },
    ...overrides,
  };
}

/** A Stripe that answers the calls the adapter makes, holds subscriptions, and writes each call down. */
function fakeStripe(
  options: {
    subscriptions?: Record<string, FakeSubscription>;
    answer?: (call: Call) => Response | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const subscriptions = options.subscriptions ?? {
    sub_1abc: stripeSubscription(),
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      path: url.pathname,
      headers: new Headers(init?.headers),
      form: new URLSearchParams(init?.body ? String(init.body) : ""),
    };
    calls.push(call);
    const custom = options.answer?.(call);
    if (custom) return custom;
    if (call.method === "POST" && call.path === "/v1/checkout/sessions") {
      return Response.json({
        id: "cs_test_1abc",
        object: "checkout.session",
        url: "https://checkout.stripe.com/c/pay/cs_test_1abc#fid",
      });
    }
    if (call.method === "POST" && call.path === "/v1/billing_portal/sessions") {
      return Response.json({
        id: "bps_1abc",
        url: "https://billing.stripe.com/p/session/test_1abc",
      });
    }
    const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(call.path);
    if (sub?.[1]) {
      const found = subscriptions[sub[1]];
      if (!found) {
        return Response.json(
          {
            error: { type: "invalid_request_error", code: "resource_missing" },
          },
          { status: 404 },
        );
      }
      return Response.json(found);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, subscriptions };
}

function provider(
  overrides: Partial<StripeConfig> = {},
  fetchImpl?: typeof fetch,
) {
  return stripeBilling({
    ...baseConfig,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...overrides,
  });
}

/** Signs a body the way Stripe does: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
function sign(body: string, options: { t?: number; secret?: string } = {}) {
  const t = options.t ?? Math.floor(NOW / 1000);
  const v1 = createHmac("sha256", options.secret ?? SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return { t, v1, header: `t=${t},v1=${v1}` };
}

const headers = (value: string) => new Headers({ "stripe-signature": value });

function event(
  type = "customer.subscription.updated",
  object: Record<string, unknown> = stripeSubscription(),
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "evt_1abc",
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: Math.floor(NOW / 1000) - 5,
    livemode: false,
    type,
    data: { object },
    ...overrides,
  };
}

function receive(
  body: unknown,
  stripe = fakeStripe(),
  options: Parameters<typeof sign>[1] = {},
) {
  const raw = JSON.stringify(body);
  return provider({}, stripe.fetchImpl).parseWebhook(
    headers(sign(raw, options).header),
    raw,
  );
}

async function refused(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal.");
}

describe("configuration", () => {
  test("a good one has no problems, and test or live is read from the key", () => {
    expect(stripeConfigProblems(baseConfig)).toEqual([]);
    expect(provider().environment).toBe("test");
    expect(provider({ secretKey: "rk_test_51restricted" }).environment).toBe(
      "test",
    );
    expect(provider({ secretKey: "sk_live_51livekey" }).environment).toBe(
      "live",
    );
  });

  test("a key, secret or price of the wrong kind is named", () => {
    const text = (config: Partial<StripeConfig>) =>
      stripeConfigProblems({ ...baseConfig, ...config }).join(" ");
    expect(text({ secretKey: "pk_test_publishable" })).toMatch(
      /STRIPE_SECRET_KEY is not a Stripe secret/,
    );
    expect(text({ webhookSecret: "pdl_ntfset_x" })).toMatch(
      /STRIPE_WEBHOOK_SECRET/,
    );
    expect(text({ prices: { agent: "pri_01" } })).toMatch(
      /not a Stripe price id/,
    );
    expect(text({ prices: {} })).toMatch(/No plan has a Stripe price/);
    expect(
      text({ prices: { agent: "price_same", team: "price_same" } }),
    ).toMatch(/same price/);
  });

  test("refuses to start with any problem, saying what", () => {
    expect(() => provider({ webhookSecret: "nope" })).toThrow(
      /not configured correctly/,
    );
  });

  test("is chosen by name from the environment, every missing setting is named, and a live key is refused", () => {
    const environment = {
      ARK_BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_51testkeyvalue",
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_PRICE_AGENT: "price_agent01",
      STRIPE_PRICE_TEAM: "price_team01",
    };
    const chosen = billingFromEnvironment(environment, { appUrl: undefined });
    expect(chosen.id).toBe("stripe");
    expect(chosen.environment).toBe("test");
    for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
      expect(() =>
        billingFromEnvironment(
          { ...environment, [key]: "" },
          { appUrl: undefined },
        ),
      ).toThrow(key);
    }
    expect(() =>
      billingFromEnvironment(
        { ...environment, STRIPE_SECRET_KEY: "sk_live_51livekey" },
        { appUrl: undefined },
      ),
    ).toThrow(/test mode only/);
  });

  test("a deployment that does not choose Stripe is unchanged", () => {
    expect(
      billingFromEnvironment(
        { STRIPE_SECRET_KEY: "sk_test_51testkeyvalue" },
        { appUrl: undefined },
      ).id,
    ).toBe("manual");
  });
});

describe("form encoding", () => {
  test("nests objects and arrays the way Stripe reads them, and leaves out what is absent", () => {
    expect(
      decodeURIComponent(
        formEncode({
          mode: "subscription",
          line_items: [{ price: "price_1", quantity: 1 }],
          subscription_data: { metadata: { tenant_id: "t" } },
          absent: undefined,
          flag: true,
        }),
      ),
    ).toBe(
      "mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[metadata][tenant_id]=t&flag=true",
    );
  });
});

describe("starting a purchase", () => {
  test("opens a subscription checkout for the plan's price that carries the account, and returns Stripe's page", async () => {
    const stripe = fakeStripe();
    const { url } = await provider({}, stripe.fetchImpl).createCheckout({
      tenantId: TENANT,
      planId: "team",
      email: "ann@example.com",
      returnUrl: RETURN,
    });
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_1abc#fid");
    const [call] = stripe.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call?.headers.get("authorization")).toBe(
      "Bearer sk_test_51testkeyvalue",
    );
    expect(call?.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(call?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(call?.form ?? [])).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_team01",
      "line_items[0][quantity]": "1",
      success_url: `${RETURN}?paid=1`,
      cancel_url: RETURN,
      client_reference_id: TENANT,
      customer_email: "ann@example.com",
      "metadata[tenant_id]": TENANT,
      "metadata[plan_id]": "team",
      "subscription_data[metadata][tenant_id]": TENANT,
      "subscription_data[metadata][plan_id]": "team",
    });
  });

  test("an address that is not one is not sent, rather than refused with the whole purchase", async () => {
    const stripe = fakeStripe();
    await provider({}, stripe.fetchImpl).createCheckout({
      tenantId: TENANT,
      planId: "agent",
      email: "not an address",
      returnUrl: RETURN,
    });
    expect(stripe.calls[0]?.form.has("customer_email")).toBe(false);
  });

  test("never sends the customer anywhere but Stripe's checkout, whatever came back", async () => {
    for (const url of [
      "https://evil.example/c/pay",
      "http://checkout.stripe.com/c/pay",
      "javascript:alert(1)",
      undefined,
    ]) {
      const stripe = fakeStripe({
        answer: (call) =>
          call.path === "/v1/checkout/sessions"
            ? Response.json({ id: "cs_test_x", url })
            : undefined,
      });
      const error = await refused(() =>
        provider({}, stripe.fetchImpl).createCheckout({
          tenantId: TENANT,
          planId: "team",
          email: "ann@example.com",
          returnUrl: RETURN,
        }),
      );
      expect(error).toBeInstanceOf(BillingUnavailableError);
    }
  });

  test("a plan with no price cannot be bought, and nothing is sent", async () => {
    const stripe = fakeStripe();
    const error = await refused(() =>
      provider(
        { prices: { agent: "price_agent01" } },
        stripe.fetchImpl,
      ).createCheckout({
        tenantId: TENANT,
        planId: "team",
        email: "ann@example.com",
        returnUrl: RETURN,
      }),
    );
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(stripe.calls).toEqual([]);
  });

  test("a refusal from Stripe reaches the customer as a sentence, without Stripe's words", async () => {
    const stripe = fakeStripe({
      answer: () =>
        Response.json(
          { error: { message: "No such price: 'price_team01'" } },
          { status: 400 },
        ),
    });
    const error = (await refused(() =>
      provider({}, stripe.fetchImpl).createCheckout({
        tenantId: TENANT,
        planId: "team",
        email: "ann@example.com",
        returnUrl: RETURN,
      }),
    )) as BillingUnavailableError;
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(error.message).not.toContain("price_team01");
    expect(String((error.cause as Error).message)).toContain("Stripe 400");
  });

  test("an unreachable Stripe is a sentence, not a crash", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await refused(() =>
      provider({}, fetchImpl).createCheckout({
        tenantId: TENANT,
        planId: "team",
        email: "ann@example.com",
        returnUrl: RETURN,
      }),
    );
    expect(error).toBeInstanceOf(BillingUnavailableError);
  });
});

describe("managing a subscription", () => {
  test("opens the customer's own billing portal, returning to the plan page", async () => {
    const stripe = fakeStripe();
    const portal = await provider({}, stripe.fetchImpl).createPortal?.(
      "cus_1abc",
      RETURN,
    );
    expect(portal?.url).toBe("https://billing.stripe.com/p/session/test_1abc");
    expect(stripe.calls[0]?.path).toBe("/v1/billing_portal/sessions");
    expect(Object.fromEntries(stripe.calls[0]?.form ?? [])).toEqual({
      customer: "cus_1abc",
      return_url: RETURN,
    });
  });

  test("an id that is not Stripe's is never put in a request", async () => {
    const stripe = fakeStripe();
    const stripeProvider = provider({}, stripe.fetchImpl);
    for (const run of [
      () => stripeProvider.createPortal?.("ctm_paddle", RETURN),
      () => stripeProvider.createPortal?.("cus_1/../../x", RETURN),
      () => stripeProvider.cancel?.("sub_1/../x", { atPeriodEnd: true }),
      () =>
        stripeProvider.changePlan?.("sub_01paddle-ish!", "team", {
          upgrade: true,
        }),
    ]) {
      expect(await refused(run)).toBeInstanceOf(BillingUnavailableError);
    }
    expect(stripe.calls).toEqual([]);
  });

  test("cancels at the end of the paid period, or at once", async () => {
    const stripe = fakeStripe();
    const stripeProvider = provider({}, stripe.fetchImpl);
    await stripeProvider.cancel?.("sub_1abc", { atPeriodEnd: true });
    await stripeProvider.cancel?.("sub_1abc", { atPeriodEnd: false });
    expect(stripe.calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/v1/subscriptions/sub_1abc"],
      ["DELETE", "/v1/subscriptions/sub_1abc"],
    ]);
    expect(stripe.calls[0]?.form.get("cancel_at_period_end")).toBe("true");
  });

  test("moves the subscription's own item to another price: an upgrade is invoiced now, a downgrade on the next invoice", async () => {
    const stripe = fakeStripe();
    const stripeProvider = provider({}, stripe.fetchImpl);
    await stripeProvider.changePlan?.("sub_1abc", "enterprise", {
      upgrade: true,
    });
    await stripeProvider.changePlan?.("sub_1abc", "agent", { upgrade: false });
    const updates = stripe.calls.filter((call) => call.method === "POST");
    expect(Object.fromEntries(updates[0]?.form ?? [])).toEqual({
      "items[0][id]": "si_1abc",
      "items[0][price]": "price_ent01",
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });
    expect(Object.fromEntries(updates[1]?.form ?? [])).toEqual({
      "items[0][id]": "si_1abc",
      "items[0][price]": "price_agent01",
      proration_behavior: "create_prorations",
    });
  });

  test("a subscription with no item of ours is not changed, so nothing is added beside it", async () => {
    const stripe = fakeStripe({
      subscriptions: {
        sub_1abc: stripeSubscription({
          items: {
            data: [
              { id: "si_1", price: { id: "price_other1" } },
              { id: "si_2", price: { id: "price_other2" } },
            ],
          },
        }),
      },
    });
    const error = await refused(() =>
      provider({}, stripe.fetchImpl).changePlan?.("sub_1abc", "team", {
        upgrade: true,
      }),
    );
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(stripe.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("usage is not charged through Stripe", () => {
    expect(provider().charge).toBeUndefined();
  });
});

describe("notifications", () => {
  test("a signed subscription notice becomes the subscription as Stripe says it is now", async () => {
    const stripe = fakeStripe();
    const [change] = await receive(
      event("customer.subscription.created"),
      stripe,
    );
    expect(change).toEqual({
      eventId: "evt_1abc",
      type: "customer.subscription.created",
      tenantId: TENANT,
      providerCustomerId: "cus_1abc",
      providerSubscriptionId: "sub_1abc",
      planId: "team",
      status: "active",
      currentPeriodEnd: new Date(1_802_592_000 * 1000),
      cancelAtPeriodEnd: false,
      occurredAt: new Date(NOW).toISOString(),
    });
    expect(stripe.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/v1/subscriptions/sub_1abc"],
    ]);
  });

  test("an older notice delivered late reports the current state, not the one it carried", async () => {
    // The event says incomplete; by the time it arrives Stripe says active.
    const stripe = fakeStripe();
    const [change] = await receive(
      event(
        "customer.subscription.created",
        stripeSubscription({ status: "incomplete" }),
      ),
      stripe,
    );
    expect(change?.status).toBe("active");
  });

  test("a completed checkout links the account through the session, even before the subscription notice", async () => {
    const stripe = fakeStripe({
      subscriptions: {
        sub_1abc: stripeSubscription({ metadata: {} }),
      },
    });
    const [change] = await receive(
      event("checkout.session.completed", {
        id: "cs_test_1abc",
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: TENANT,
        customer: "cus_1abc",
        subscription: "sub_1abc",
      }),
      stripe,
    );
    expect(change).toMatchObject({
      tenantId: TENANT,
      providerSubscriptionId: "sub_1abc",
      planId: "team",
      status: "active",
    });
  });

  test("a one-off payment checkout is not about a subscription", async () => {
    const stripe = fakeStripe();
    expect(
      await receive(
        event("checkout.session.completed", {
          mode: "payment",
          client_reference_id: TENANT,
        }),
        stripe,
      ),
    ).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });

  test("reads the plan from the price, the period end from either place Stripe has kept it, and a price we do not sell gives no plan", async () => {
    const older = fakeStripe({
      subscriptions: {
        sub_1abc: stripeSubscription({
          current_period_end: 1_802_000_000,
          items: { data: [{ id: "si_1", price: { id: "price_ent01" } }] },
        }),
      },
    });
    const [change] = await receive(event(), older);
    expect(change?.planId).toBe("enterprise");
    expect(change?.currentPeriodEnd).toEqual(new Date(1_802_000_000 * 1000));

    const foreign = fakeStripe({
      subscriptions: {
        sub_1abc: stripeSubscription({
          items: { data: [{ id: "si_1", price: { id: "price_unknown" } }] },
        }),
      },
    });
    const [other] = await receive(event(), foreign);
    expect(other?.planId).toBeUndefined();
  });

  test("a scheduled end is 'ends at the end of the period', by either of Stripe's ways of saying so", async () => {
    for (const scheduled of [
      { cancel_at_period_end: true },
      { cancel_at: 1_802_592_000 },
    ]) {
      const stripe = fakeStripe({
        subscriptions: { sub_1abc: stripeSubscription(scheduled) },
      });
      const [change] = await receive(event(), stripe);
      expect(change?.cancelAtPeriodEnd).toBe(true);
    }
    const ended = fakeStripe({
      subscriptions: {
        sub_1abc: stripeSubscription({
          status: "canceled",
          cancel_at_period_end: true,
        }),
      },
    });
    const [change] = await receive(
      event("customer.subscription.deleted"),
      ended,
    );
    expect(change).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
  });

  test("statuses are translated, and one we do not know changes nothing", () => {
    expect(statusFromStripe("active")).toBe("active");
    expect(statusFromStripe("trialing")).toBe("trialing");
    expect(statusFromStripe("past_due")).toBe("past_due");
    expect(statusFromStripe("incomplete")).toBe("incomplete");
    for (const ended of [
      "canceled",
      "unpaid",
      "paused",
      "incomplete_expired",
    ]) {
      expect(statusFromStripe(ended)).toBe("canceled");
    }
    expect(statusFromStripe("something_new")).toBeUndefined();
  });

  test("a tenant id that is not one of ours is not believed", async () => {
    const stripe = fakeStripe({
      subscriptions: {
        sub_1abc: stripeSubscription({ metadata: { tenant_id: "1 OR 1=1" } }),
      },
    });
    const [change] = await receive(event(), stripe);
    expect(change?.tenantId).toBeUndefined();
    expect(change?.providerCustomerId).toBe("cus_1abc");
  });

  test("anything that is not about a subscription is ignored without asking Stripe", async () => {
    const stripe = fakeStripe();
    expect(
      await receive(event("invoice.paid", { id: "in_1" }), stripe),
    ).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });

  test("a live event at a test deployment is somebody's mistake, not a payment", async () => {
    const stripe = fakeStripe();
    expect(
      await receive(event(undefined, undefined, { livemode: true }), stripe),
    ).toEqual([]);
    expect(stripe.calls).toEqual([]);
  });

  test("a body with a wrong, missing or malformed signature is refused", async () => {
    const stripe = fakeStripe();
    const stripeProvider = provider({}, stripe.fetchImpl);
    const raw = JSON.stringify(event());
    const good = sign(raw);
    for (const header of [
      "",
      `t=${good.t}`,
      `v1=${good.v1}`,
      `t=${good.t},v1=${"0".repeat(64)}`,
      sign(raw, { secret: "whsec_someoneelse" }).header,
      // v0 is Stripe's test-only scheme and proves nothing.
      `t=${good.t},v0=${good.v1}`,
      `t=abc,v1=${good.v1}`,
    ]) {
      expect(
        await refused(() => stripeProvider.parseWebhook(headers(header), raw)),
      ).toBeInstanceOf(BillingSignatureError);
    }
    // The signature is over the exact bytes: one changed character is a different body.
    expect(
      await refused(() =>
        stripeProvider.parseWebhook(
          headers(good.header),
          raw.replace("sub_1abc", "sub_2abc"),
        ),
      ),
    ).toBeInstanceOf(BillingSignatureError);
    expect(stripe.calls).toEqual([]);
  });

  test("a notice from too long ago or the future is refused, even with a good signature", async () => {
    const stripe = fakeStripe();
    for (const offset of [-301, 301]) {
      expect(
        await refused(() =>
          receive(event(), stripe, { t: Math.floor(NOW / 1000) + offset }),
        ),
      ).toBeInstanceOf(BillingSignatureError);
    }
    expect(
      await receive(event(), stripe, { t: Math.floor(NOW / 1000) - 299 }),
    ).toHaveLength(1);
  });

  test("while a secret is being rolled, any one of the signatures offered is enough", async () => {
    const stripe = fakeStripe();
    const raw = JSON.stringify(event());
    const good = sign(raw);
    const [change] = await provider({}, stripe.fetchImpl).parseWebhook(
      headers(`t=${good.t},v1=${"a".repeat(64)},v1=${good.v1}`),
      raw,
    );
    expect(change?.eventId).toBe("evt_1abc");
  });

  test("a body that is not JSON is refused even when the signature matches it", async () => {
    const raw = "not json";
    expect(
      await refused(() =>
        provider().parseWebhook(headers(sign(raw).header), raw),
      ),
    ).toBeInstanceOf(BillingSignatureError);
  });

  test("when Stripe cannot be asked, the delivery fails so that Stripe sends it again", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const raw = JSON.stringify(event());
    const error = await refused(() =>
      provider({}, fetchImpl).parseWebhook(headers(sign(raw).header), raw),
    );
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(error).not.toBeInstanceOf(BillingSignatureError);
  });
});

describe("setting up a test account", () => {
  function fakeCatalogue(existing: Record<string, unknown>[] = []) {
    const calls: Array<{
      method: string;
      path: string;
      form: URLSearchParams;
    }> = [];
    let productExists = existing.length > 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const form = new URLSearchParams(init?.body ? String(init.body) : "");
      calls.push({ method, path: `${url.pathname}${url.search}`, form });
      if (url.pathname === "/v1/products/ark_plans") {
        return productExists
          ? Response.json({ id: "ark_plans" })
          : Response.json(
              { error: { code: "resource_missing" } },
              { status: 404 },
            );
      }
      if (method === "POST" && url.pathname === "/v1/products") {
        productExists = true;
        return Response.json({ id: "ark_plans" });
      }
      if (method === "GET" && url.pathname === "/v1/prices") {
        return Response.json({ data: existing });
      }
      if (method === "POST" && url.pathname === "/v1/prices") {
        return Response.json({ id: `price_${form.get("lookup_key")}` });
      }
      if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
        return Response.json({
          id: "cs_test_x",
          url: "https://checkout.stripe.com/c/pay/cs_test_x",
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("makes the product and one monthly EUR price per plan, from the plan table", async () => {
    const stripe = fakeCatalogue();
    const result = await setupStripe({
      secretKey: "sk_test_51testkeyvalue",
      fetchImpl: stripe.fetchImpl,
    });
    expect(result.created).toEqual([
      "product",
      "price:agent",
      "price:team",
      "price:enterprise",
    ]);
    expect(result.prices.team).toBe("price_ark_team_monthly");
    const team = stripe.calls.find(
      (call) =>
        call.method === "POST" &&
        call.form.get("lookup_key") === "ark_team_monthly",
    );
    expect(Object.fromEntries(team?.form ?? [])).toMatchObject({
      product: "ark_plans",
      currency: "eur",
      unit_amount: "10000",
      "recurring[interval]": "month",
    });
  });

  test("a second run finds what is there, and reports a price that differs instead of changing it", async () => {
    const stripe = fakeCatalogue([
      {
        id: "price_a",
        lookup_key: "ark_agent_monthly",
        unit_amount: 5_000,
        currency: "eur",
      },
      {
        id: "price_t",
        lookup_key: "ark_team_monthly",
        unit_amount: 9_000,
        currency: "eur",
      },
      {
        id: "price_e",
        lookup_key: "ark_enterprise_monthly",
        unit_amount: 25_000,
        currency: "eur",
      },
    ]);
    const result = await setupStripe({
      secretKey: "sk_test_51testkeyvalue",
      fetchImpl: stripe.fetchImpl,
    });
    expect(result.created).toEqual([]);
    expect(result.prices).toEqual({
      agent: "price_a",
      team: "price_t",
      enterprise: "price_e",
    });
    expect(result.drift).toEqual([
      { plan: "team", stripeCents: 9_000, tableCents: 10_000 },
    ]);
    expect(stripe.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("a live key or something that is not a key creates nothing", async () => {
    const stripe = fakeCatalogue();
    for (const secretKey of ["sk_live_51livekey", "pk_test_publishable"]) {
      expect(
        await refused(() =>
          setupStripe({ secretKey, fetchImpl: stripe.fetchImpl }),
        ),
      ).toBeInstanceOf(Error);
      expect(
        await refused(() =>
          tryStripeCheckout({
            secretKey,
            priceId: "price_a",
            returnUrl: RETURN,
            fetchImpl: stripe.fetchImpl,
          }),
        ),
      ).toBeInstanceOf(Error);
    }
    expect(stripe.calls).toEqual([]);
  });
});
