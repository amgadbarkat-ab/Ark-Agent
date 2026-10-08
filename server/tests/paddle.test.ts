import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { billingFromEnvironment } from "../src/billing/select";
import {
  type PaddleConfig,
  paddleBilling,
  paddleConfigProblems,
  statusFromPaddle,
} from "../src/billing/paddle";
import {
  BillingChargeUncertain,
  BillingSignatureError,
  BillingUnavailableError,
} from "../src/billing/provider";

/**
 * Paddle as a payment provider, against a fake Paddle that follows its published API. Nothing here
 * reaches Paddle: the request shapes, the signature scheme and the notification fields are the
 * documented ones, and the first real run belongs in Paddle's sandbox (docs/ark/12-paddle.md).
 */

const SECRET = "pdl_ntfset_01testsecretvalue";
const TENANT = "11111111-2222-4333-8444-555555555555";
const NOW = 1_800_000_000_000;
const CHECKOUT = "https://ark.example.test/api/billing/checkout";

const baseConfig: PaddleConfig = {
  apiKey: "pdl_sdbx_apikey_01testkey",
  webhookSecret: SECRET,
  clientToken: "test_1234567890abcdef",
  environment: "sandbox",
  prices: { agent: "pri_agent", team: "pri_team", enterprise: "pri_ent" },
  checkoutUrl: CHECKOUT,
  now: () => NOW,
};

type Call = {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
};

/** A Paddle that answers the calls the adapter makes, and writes each one down. */
function fakePaddle(
  answer: (call: Call) => Response | undefined = () => undefined,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const custom = answer(call);
    if (custom) return custom;
    const path = new URL(call.url).pathname;
    if (call.method === "POST" && path === "/transactions") {
      const url = (call.body as { checkout: { url: string } }).checkout.url;
      return Response.json(
        {
          data: {
            id: "txn_01abc",
            checkout: { url: `${url}?_ptxn=txn_01abc` },
          },
        },
        { status: 201 },
      );
    }
    if (path.endsWith("/portal-sessions")) {
      return Response.json(
        {
          data: {
            urls: {
              general: {
                overview: "https://customer-portal.paddle.com/cpl_1?token=t",
              },
            },
          },
        },
        { status: 201 },
      );
    }
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  overrides: Partial<PaddleConfig> = {},
  fetchImpl?: typeof fetch,
) {
  return paddleBilling({
    ...baseConfig,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...overrides,
  });
}

function sign(body: string, options: { ts?: number; secret?: string } = {}) {
  const ts = options.ts ?? Math.floor(NOW / 1000);
  const h1 = createHmac("sha256", options.secret ?? SECRET)
    .update(`${ts}:${body}`)
    .digest("hex");
  return { ts, h1, header: `ts=${ts};h1=${h1}` };
}

const headers = (value: string) => new Headers({ "paddle-signature": value });

function subscription(
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) {
  return {
    event_id: "evt_01aaa",
    event_type: "subscription.created",
    occurred_at: "2026-10-08T10:00:00.123456Z",
    notification_id: "ntf_01",
    data: {
      id: "sub_01abc",
      status: "active",
      customer_id: "ctm_01abc",
      custom_data: { tenant_id: TENANT, plan_id: "team" },
      current_billing_period: {
        starts_at: "2026-10-08T10:00:00Z",
        ends_at: "2026-11-08T10:00:00Z",
      },
      scheduled_change: null,
      items: [{ status: "active", quantity: 1, price: { id: "pri_team" } }],
      ...data,
    },
    ...overrides,
  };
}

function receive(
  body: unknown,
  options: Parameters<typeof sign>[1] = {},
  paddle = provider(),
) {
  const raw = JSON.stringify(body);
  return paddle.parseWebhook(headers(sign(raw, options).header), raw);
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
  test("a good one has no problems", () => {
    expect(paddleConfigProblems(baseConfig)).toEqual([]);
  });

  test("a key, token or secret from the other environment, or of the wrong kind, is named", () => {
    const problems = paddleConfigProblems({
      ...baseConfig,
      environment: "production",
    });
    expect(problems.join(" ")).toMatch(/PADDLE_API_KEY is not a live API key/);
    expect(problems.join(" ")).toMatch(/PADDLE_CLIENT_TOKEN is not a live/);
    expect(
      paddleConfigProblems({ ...baseConfig, webhookSecret: "whsec_x" }).join(
        " ",
      ),
    ).toMatch(/PADDLE_WEBHOOK_SECRET/);
    expect(
      paddleConfigProblems({
        ...baseConfig,
        prices: { agent: "price_1" },
      }).join(" "),
    ).toMatch(/not a Paddle price id/);
    expect(
      paddleConfigProblems({ ...baseConfig, prices: {} }).join(" "),
    ).toMatch(/No plan has a Paddle price/);
    expect(
      paddleConfigProblems({
        ...baseConfig,
        clientToken: "test_has space!",
      }).join(" "),
    ).toMatch(/characters a token does not/);
    expect(
      paddleConfigProblems({
        ...baseConfig,
        checkoutUrl: "http://ark.example.test/x",
      }).join(" "),
    ).toMatch(/https/);
  });

  test("refuses to start with any problem, saying what", () => {
    expect(() => provider({ environment: "production" })).toThrow(
      /not configured correctly/,
    );
  });

  test("is chosen by name from the environment, and every missing setting is named", () => {
    const env = {
      ARK_BILLING_PROVIDER: "paddle",
      PADDLE_API_KEY: "pdl_sdbx_apikey_01testkey",
      PADDLE_WEBHOOK_SECRET: SECRET,
      PADDLE_CLIENT_TOKEN: "test_1234567890abcdef",
      PADDLE_PRICE_AGENT: "pri_agent",
      PADDLE_PRICE_TEAM: "pri_team",
      PADDLE_PRICE_ENTERPRISE: "pri_ent",
    };
    const deployment = { appUrl: "https://ark.example.test/" };
    expect(billingFromEnvironment(env, deployment).id).toBe("paddle");
    for (const key of [
      "PADDLE_API_KEY",
      "PADDLE_WEBHOOK_SECRET",
      "PADDLE_CLIENT_TOKEN",
    ]) {
      expect(() =>
        billingFromEnvironment({ ...env, [key]: "" }, deployment),
      ).toThrow(new RegExp(key));
    }
    expect(() => billingFromEnvironment(env, { appUrl: undefined })).toThrow(
      /APP_URL/,
    );
    expect(() =>
      billingFromEnvironment(
        { ...env, PADDLE_ENVIRONMENT: "live" },
        deployment,
      ),
    ).toThrow(/sandbox or production/);
    // A live key never goes to Paddle's sandbox by guesswork, nor a sandbox key to the live service.
    expect(() =>
      billingFromEnvironment(
        { ...env, PADDLE_ENVIRONMENT: "production" },
        deployment,
      ),
    ).toThrow(/live API key/);
  });
});

describe("starting a purchase", () => {
  test("creates a transaction for the plan's price that carries the account, and returns our own checkout page", async () => {
    const paddle = fakePaddle();
    const result = await provider({}, paddle.fetchImpl).createCheckout({
      tenantId: TENANT,
      planId: "team",
      email: "ann@example.com",
      returnUrl: "https://ark.example.test/settings/plan",
    });
    expect(result.url).toBe(`${CHECKOUT}?_ptxn=txn_01abc`);
    const [call] = paddle.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://sandbox-api.paddle.com/transactions");
    expect(call?.headers.get("authorization")).toBe(
      "Bearer pdl_sdbx_apikey_01testkey",
    );
    expect(call?.body).toEqual({
      items: [{ price_id: "pri_team", quantity: 1 }],
      custom_data: { tenant_id: TENANT, plan_id: "team" },
      checkout: { url: CHECKOUT },
    });
  });

  test("talks to the live service only when told it is live", async () => {
    const paddle = fakePaddle();
    await provider(
      {
        environment: "production",
        apiKey: "pdl_live_apikey_01livekey",
        clientToken: "live_1234567890abcdef",
      },
      paddle.fetchImpl,
    ).createCheckout({
      tenantId: TENANT,
      planId: "agent",
      email: "a@b.c",
      returnUrl: "https://x.test",
    });
    expect(paddle.calls[0]?.url).toBe("https://api.paddle.com/transactions");
  });

  test("never sends the customer anywhere but our own page, whatever came back", async () => {
    const paddle = fakePaddle(() =>
      Response.json(
        { data: { checkout: { url: "https://evil.example/pay?_ptxn=txn_1" } } },
        { status: 201 },
      ),
    );
    const error = await refused(() =>
      provider({}, paddle.fetchImpl).createCheckout({
        tenantId: TENANT,
        planId: "team",
        email: "a@b.c",
        returnUrl: "https://x.test",
      }),
    );
    expect(error).toBeInstanceOf(BillingUnavailableError);
  });

  test("a plan with no price cannot be bought, and nothing is sent", async () => {
    const paddle = fakePaddle();
    const error = await refused(() =>
      provider(
        { prices: { agent: "pri_agent" } },
        paddle.fetchImpl,
      ).createCheckout({
        tenantId: TENANT,
        planId: "team",
        email: "a@b.c",
        returnUrl: "https://x.test",
      }),
    );
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(paddle.calls).toEqual([]);
  });

  test("a refusal from Paddle reaches the customer as a sentence, without Paddle's words", async () => {
    const paddle = fakePaddle(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            detail: "API key is missing transaction.write",
          },
        },
        { status: 403 },
      ),
    );
    const error = (await refused(() =>
      provider({}, paddle.fetchImpl).createCheckout({
        tenantId: TENANT,
        planId: "team",
        email: "a@b.c",
        returnUrl: "https://x.test",
      }),
    )) as BillingUnavailableError;
    expect(error).toBeInstanceOf(BillingUnavailableError);
    expect(error.message).not.toMatch(/transaction\.write|403|API key/);
    // The operator still gets it.
    expect(String((error.cause as Error).message)).toMatch(/403/);
  });

  test("an unreachable Paddle is a sentence, not a crash", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(
      await refused(() =>
        provider({}, fetchImpl).createCheckout({
          tenantId: TENANT,
          planId: "team",
          email: "a@b.c",
          returnUrl: "https://x.test",
        }),
      ),
    ).toBeInstanceOf(BillingUnavailableError);
  });
});

describe("managing a subscription", () => {
  test("opens the customer's own billing page", async () => {
    const paddle = fakePaddle();
    const portal = await provider({}, paddle.fetchImpl).createPortal?.(
      "ctm_01abc",
      "https://x.test",
    );
    expect(portal?.url).toStartWith("https://customer-portal.paddle.com/");
    expect(paddle.calls[0]?.url).toBe(
      "https://sandbox-api.paddle.com/customers/ctm_01abc/portal-sessions",
    );
  });

  test("an id that is not Paddle's is never put in a path", async () => {
    const paddle = fakePaddle();
    const p = provider({}, paddle.fetchImpl);
    for (const bad of ["ctm_x/../../subscriptions", "ctm_X", "", "sub_01abc"]) {
      expect(
        await refused(() => p.createPortal?.(bad, "https://x.test")),
      ).toBeInstanceOf(BillingUnavailableError);
    }
    for (const bad of ["sub_x/cancel?x", "ctm_01abc", "../x"]) {
      expect(
        await refused(() => p.cancel?.(bad, { atPeriodEnd: true })),
      ).toBeInstanceOf(BillingUnavailableError);
      expect(
        await refused(() => p.changePlan?.(bad, "team", { upgrade: true })),
      ).toBeInstanceOf(BillingUnavailableError);
    }
    expect(paddle.calls).toEqual([]);
  });

  test("cancels at the end of the paid period, or at once", async () => {
    const paddle = fakePaddle();
    const p = provider({}, paddle.fetchImpl);
    await p.cancel?.("sub_01abc", { atPeriodEnd: true });
    await p.cancel?.("sub_01abc", { atPeriodEnd: false });
    expect(
      paddle.calls.map((c) => [c.method, new URL(c.url).pathname, c.body]),
    ).toEqual([
      [
        "POST",
        "/subscriptions/sub_01abc/cancel",
        { effective_from: "next_billing_period" },
      ],
      [
        "POST",
        "/subscriptions/sub_01abc/cancel",
        { effective_from: "immediately" },
      ],
    ]);
  });

  test("moves the subscription to another plan: an upgrade is charged now, a downgrade at renewal", async () => {
    const paddle = fakePaddle();
    const p = provider({}, paddle.fetchImpl);
    await p.changePlan?.("sub_01abc", "enterprise", { upgrade: true });
    await p.changePlan?.("sub_01abc", "agent", { upgrade: false });
    expect(
      paddle.calls.map((c) => [c.method, new URL(c.url).pathname, c.body]),
    ).toEqual([
      [
        "PATCH",
        "/subscriptions/sub_01abc",
        {
          items: [{ price_id: "pri_ent", quantity: 1 }],
          proration_billing_mode: "prorated_immediately",
        },
      ],
      [
        "PATCH",
        "/subscriptions/sub_01abc",
        {
          items: [{ price_id: "pri_agent", quantity: 1 }],
          proration_billing_mode: "prorated_next_billing_period",
        },
      ],
    ]);
  });
});

describe("charging for what was used", () => {
  const request = { amountCents: 1234, description: "Cloud running 2026-09" };
  const cloud = { cloudProductId: "pro_cloud01" };

  test("asks Paddle to charge the subscription once, immediately, for the exact amount, tax added on top", async () => {
    const paddle = fakePaddle();
    const p = provider(cloud, paddle.fetchImpl);
    const result = await p.charge?.("sub_01abc", request);
    expect(result?.reference).toContain("sub_01abc");
    expect(paddle.calls).toHaveLength(1);
    const [call] = paddle.calls;
    expect(call?.method).toBe("POST");
    expect(new URL(call?.url ?? "").pathname).toBe(
      "/subscriptions/sub_01abc/charge",
    );
    expect(call?.headers.get("authorization")).toBe(
      `Bearer ${baseConfig.apiKey}`,
    );
    expect(call?.body).toEqual({
      effective_from: "immediately",
      // A refused card applies nothing: a definite no, never a half-done charge.
      on_payment_failure: "prevent_change",
      items: [
        {
          quantity: 1,
          price: {
            description: "Cloud running 2026-09",
            name: "Ark cloud running",
            product_id: "pro_cloud01",
            unit_price: { amount: "1234", currency_code: "EUR" },
            // The amount was worked out to cover cost; tax must not come out of it.
            tax_mode: "external",
          },
        },
      ],
    });
  });

  test("a refusal from Paddle (a 4xx) is a definite no that is safe to try again later", async () => {
    const paddle = fakePaddle(() =>
      Response.json(
        { error: { code: "forbidden", detail: "Card declined" } },
        { status: 422 },
      ),
    );
    const failure = await provider(cloud, paddle.fetchImpl)
      .charge?.("sub_01abc", request)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(BillingUnavailableError);
    expect(failure).not.toBeInstanceOf(BillingChargeUncertain);
    expect(String((failure as Error).cause)).toContain("Card declined");
  });

  test("a server error is not a no: the money may have been taken, so it is uncertain", async () => {
    const paddle = fakePaddle(() => new Response("oops", { status: 502 }));
    const failure = await provider(cloud, paddle.fetchImpl)
      .charge?.("sub_01abc", request)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(BillingChargeUncertain);
  });

  test("a request that was sent and never answered is uncertain, never refused", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const failure = await provider(cloud, fetchImpl)
      .charge?.("sub_01abc", request)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(BillingChargeUncertain);
  });

  test("without a usage product, nothing is sent and the answer is a definite no", async () => {
    const paddle = fakePaddle();
    const failure = await provider({}, paddle.fetchImpl)
      .charge?.("sub_01abc", request)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(BillingUnavailableError);
    expect(paddle.calls).toEqual([]);
  });

  test("an amount that is not whole cents in range, or a subscription id that is not one, sends nothing", async () => {
    const paddle = fakePaddle();
    const p = provider(cloud, paddle.fetchImpl);
    for (const amountCents of [0, -5, 12.5, Number.NaN, 1_000_001]) {
      await expect(
        p.charge?.("sub_01abc", { ...request, amountCents }),
      ).rejects.toBeInstanceOf(BillingUnavailableError);
    }
    await expect(p.charge?.("../customers", request)).rejects.toBeInstanceOf(
      BillingUnavailableError,
    );
    expect(paddle.calls).toEqual([]);
  });

  test("a usage product id that is not one is a configuration problem", () => {
    expect(
      paddleConfigProblems({ ...baseConfig, cloudProductId: "oops" }),
    ).toContain('PADDLE_PRODUCT_CLOUD is not a Paddle product id ("pro_...").');
    expect(
      paddleConfigProblems({ ...baseConfig, cloudProductId: "pro_cloud01" }),
    ).not.toContain(
      'PADDLE_PRODUCT_CLOUD is not a Paddle product id ("pro_...").',
    );
  });

  test("PADDLE_PRODUCT_CLOUD is read from the environment, and is optional", () => {
    const env = {
      ARK_BILLING_PROVIDER: "paddle",
      PADDLE_API_KEY: "pdl_sdbx_apikey_01testkey",
      PADDLE_WEBHOOK_SECRET: SECRET,
      PADDLE_CLIENT_TOKEN: "test_1234567890abcdef",
      PADDLE_PRICE_AGENT: "pri_agent",
    };
    const deployment = { appUrl: "https://ark.example.test/" };
    expect(typeof billingFromEnvironment(env, deployment).charge).toBe(
      "function",
    );
    expect(() =>
      billingFromEnvironment(
        { ...env, PADDLE_PRODUCT_CLOUD: "oops" },
        deployment,
      ),
    ).toThrow(/PADDLE_PRODUCT_CLOUD/);
    expect(
      billingFromEnvironment(
        { ...env, PADDLE_PRODUCT_CLOUD: "pro_cloud01" },
        deployment,
      ).id,
    ).toBe("paddle");
  });
});

describe("notifications", () => {
  test("a signed subscription notice becomes a change to the account it was made for", async () => {
    const [event] = await receive(subscription());
    expect(event).toEqual({
      eventId: "evt_01aaa",
      type: "subscription.created",
      tenantId: TENANT,
      providerCustomerId: "ctm_01abc",
      providerSubscriptionId: "sub_01abc",
      planId: "team",
      status: "active",
      currentPeriodEnd: new Date("2026-11-08T10:00:00Z"),
      cancelAtPeriodEnd: false,
      // Kept exactly, microseconds and all: it decides which of two notices is the later.
      occurredAt: "2026-10-08T10:00:00.123456Z",
    });
  });

  test("reads the plan from the price, and a price we do not sell gives no plan", async () => {
    const [enterprise] = await receive(
      subscription({}, { items: [{ price: { id: "pri_ent" } }] }),
    );
    expect(enterprise?.planId).toBe("enterprise");
    const [unknown] = await receive(
      subscription({}, { items: [{ price: { id: "pri_somebody_elses" } }] }),
    );
    expect(unknown?.planId).toBeUndefined();
    const [both] = await receive(
      subscription(
        {},
        { items: [{ price: { id: "pri_other" } }, { price_id: "pri_agent" }] },
      ),
    );
    expect(both?.planId).toBe("agent");
  });

  test("a cancellation Paddle has scheduled is 'ends at the end of the period'; a pause is not one", async () => {
    const [cancelling] = await receive(
      subscription(
        { event_type: "subscription.updated" },
        {
          scheduled_change: {
            action: "cancel",
            effective_at: "2026-11-08T10:00:00Z",
          },
        },
      ),
    );
    expect(cancelling).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: true,
    });
    const [pausing] = await receive(
      subscription(
        { event_type: "subscription.updated" },
        {
          scheduled_change: {
            action: "pause",
            effective_at: "2026-11-08T10:00:00Z",
          },
        },
      ),
    );
    expect(pausing?.cancelAtPeriodEnd).toBe(false);
  });

  test("statuses are translated, and one we do not know changes nothing", () => {
    expect(statusFromPaddle("active")).toBe("active");
    expect(statusFromPaddle("trialing")).toBe("trialing");
    expect(statusFromPaddle("past_due")).toBe("past_due");
    expect(statusFromPaddle("canceled")).toBe("canceled");
    // A paused subscription must not run.
    expect(statusFromPaddle("paused")).toBe("canceled");
    expect(statusFromPaddle("something_new")).toBeUndefined();
    expect(statusFromPaddle(undefined)).toBeUndefined();
  });

  test("a cancelled subscription is cancelled", async () => {
    const [event] = await receive(
      subscription(
        { event_type: "subscription.canceled" },
        { status: "canceled" },
      ),
    );
    expect(event).toMatchObject({
      type: "subscription.canceled",
      status: "canceled",
    });
  });

  test("a tenant id that is not one of ours is not believed", async () => {
    const [event] = await receive(
      subscription({}, { custom_data: { tenant_id: "../../etc/passwd" } }),
    );
    expect(event?.tenantId).toBeUndefined();
    expect(event?.providerCustomerId).toBe("ctm_01abc");
  });

  test("anything that is not about a subscription is ignored", async () => {
    for (const type of [
      "transaction.completed",
      "customer.updated",
      "price.created",
    ]) {
      expect(
        await receive({ event_id: "evt_x", event_type: type, data: {} }),
      ).toEqual([]);
    }
  });

  test("a body with a wrong, missing or malformed signature is refused", async () => {
    const raw = JSON.stringify(subscription());
    const good = sign(raw);
    for (const header of [
      "",
      "garbage",
      `ts=${good.ts}`,
      `h1=${good.h1}`,
      `ts=${good.ts};h1=${"0".repeat(64)}`,
      `ts=${good.ts};h1=${good.h1.slice(0, 10)}`,
      `ts=abc;h1=${good.h1}`,
      `ts=${good.ts};h1=${sign(raw, { secret: "pdl_ntfset_other" }).h1}`,
    ]) {
      expect(
        await refused(() => provider().parseWebhook(headers(header), raw)),
      ).toBeInstanceOf(BillingSignatureError);
    }
    // A signature is over the exact bytes: one changed character is a different message.
    expect(
      await refused(() =>
        provider().parseWebhook(
          headers(good.header),
          raw.replace("sub_01abc", "sub_02abc"),
        ),
      ),
    ).toBeInstanceOf(BillingSignatureError);
    expect(
      await refused(() => provider().parseWebhook(new Headers(), raw)),
    ).toBeInstanceOf(BillingSignatureError);
  });

  test("a notice from too long ago or the future is refused, even with a good signature", async () => {
    const body = subscription();
    const early = Math.floor(NOW / 1000) - 301;
    const late = Math.floor(NOW / 1000) + 301;
    expect(await refused(() => receive(body, { ts: early }))).toBeInstanceOf(
      BillingSignatureError,
    );
    expect(await refused(() => receive(body, { ts: late }))).toBeInstanceOf(
      BillingSignatureError,
    );
    // Inside the window is fine, and the window can be set.
    expect(
      await receive(body, { ts: Math.floor(NOW / 1000) - 299 }),
    ).toHaveLength(1);
    expect(
      await refused(() =>
        receive(
          body,
          { ts: Math.floor(NOW / 1000) - 20 },
          provider({ toleranceSeconds: 5 }),
        ),
      ),
    ).toBeInstanceOf(BillingSignatureError);
  });

  test("while Paddle rotates a secret, any one of the signatures offered is enough", () => {
    const raw = JSON.stringify(subscription());
    const good = sign(raw);
    const old = sign(raw, { secret: "pdl_ntfset_retired" });
    expect(
      provider().parseWebhook(
        headers(`ts=${good.ts};h1=${old.h1};h1=${good.h1}`),
        raw,
      ),
    ).toHaveLength(1);
    expect(() =>
      provider().parseWebhook(
        headers(`ts=${good.ts};h1=${old.h1};h1=${old.h1}`),
        raw,
      ),
    ).toThrow(BillingSignatureError);
  });

  test("a body that is not JSON is refused even when the signature matches it", () => {
    const raw = "{not json";
    expect(() =>
      provider().parseWebhook(headers(sign(raw).header), raw),
    ).toThrow(BillingSignatureError);
  });
});

describe("the checkout page", () => {
  const page = (
    overrides: Partial<PaddleConfig> = {},
    successUrl = "https://ark.example.test/settings/plan?paid=1",
  ) => provider(overrides).checkoutPage?.({ successUrl }) ?? "";

  test("loads Paddle.js from Paddle and opens the transaction it was sent, returning to the plan page", () => {
    const html = page();
    expect(html).toContain(
      '<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>',
    );
    expect(html).toContain('"test_1234567890abcdef"');
    expect(html).toContain('"https://ark.example.test/settings/plan?paid=1"');
    expect(html).toContain("successUrl");
    expect(html).toContain("_ptxn=txn_");
    expect(html).toContain("checkout.closed");
    // The way back for someone who closes it.
    expect(html).toContain('href="https://ark.example.test/settings/plan"');
  });

  test("uses Paddle's sandbox only in a sandbox configuration", () => {
    expect(page()).toContain('Paddle.Environment.set("sandbox")');
    expect(
      page({
        environment: "production",
        apiKey: "pdl_live_apikey_01livekey",
        clientToken: "live_1234567890abcdef",
      }),
    ).not.toContain("Environment.set");
  });

  test("puts nothing but encoded text into the script, whatever the address says", () => {
    const html = page(
      {},
      'https://ark.example.test/p?x="</script><script>alert(1)</script>&y= ',
    );
    // Our two script elements and nothing else.
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("alert(1)</script>");
    expect(html).not.toContain(" ");
  });

  test("holds no API key and no webhook secret", () => {
    const html = page();
    expect(html).not.toContain("pdl_sdbx_apikey_");
    expect(html).not.toContain("pdl_ntfset_");
  });
});
