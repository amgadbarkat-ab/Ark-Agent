import { afterEach, describe, expect, test } from "bun:test";
import { stripeReadOnly } from "./stripe";
import { testBoard } from "./test-helpers";

const KEY = "rk_test_readonly_standin";
const servers: Array<{ stop: (force?: boolean) => void }> = [];
let current: ReturnType<typeof testBoard> | null = null;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  current?.cleanup();
  current = null;
});

const T = 1_795_000_000; // seconds

/** A stand-in for api.stripe.com: GET only, the restricted key only, two pages of subscriptions. */
function fakeStripe() {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}?${url.searchParams}`);
      if (request.method !== "GET") return new Response("{}", { status: 405 });
      if (request.headers.get("authorization") !== `Bearer ${KEY}`)
        return new Response("{}", { status: 401 });
      if (
        url.pathname === "/v1/subscriptions" &&
        !url.searchParams.has("starting_after")
      ) {
        return Response.json({
          has_more: url.searchParams.get("limit") === "100",
          data: [
            {
              id: "sub_1",
              customer: "cus_1",
              status: "active",
              cancel_at_period_end: false,
              items: {
                data: [
                  {
                    quantity: 1,
                    current_period_end: T + 86_400 * 20,
                    price: {
                      unit_amount: 4900,
                      currency: "eur",
                      recurring: { interval: "month" },
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.pathname === "/v1/subscriptions") {
        expect(url.searchParams.get("starting_after")).toBe("sub_1");
        return Response.json({
          has_more: false,
          data: [
            {
              id: "sub_2",
              customer: "cus_2",
              status: "past_due",
              cancel_at_period_end: true,
              current_period_end: T + 86_400 * 3,
              items: {
                data: [
                  {
                    quantity: 2,
                    price: {
                      unit_amount: 4900,
                      currency: "eur",
                      recurring: { interval: "month" },
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.pathname === "/v1/checkout/sessions") {
        return Response.json({
          has_more: false,
          data: [
            {
              id: "cs_1",
              subscription: "sub_1",
              client_reference_id: "demo-shop",
            },
            {
              id: "cs_x",
              subscription: null,
              client_reference_id: "demo-topup",
            },
          ],
        });
      }
      if (url.pathname === "/v1/invoices") {
        return Response.json({
          has_more: false,
          data: [
            {
              id: "in_1",
              customer: "cus_1",
              parent: { subscription_details: { subscription: "sub_1" } },
              amount_due: 4900,
              currency: "eur",
              attempt_count: 2,
              next_payment_attempt: T + 86_400,
              created: T - 86_400,
            },
            {
              id: "in_2",
              customer: "cus_2",
              subscription: "sub_2",
              amount_due: 9800,
              currency: "eur",
              attempt_count: 0,
              attempted: false,
              created: T,
            },
          ],
        });
      }
      return new Response("{}", { status: 404 });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seen };
}

describe("Stripe, read-only", () => {
  test("reads subscriptions (all pages), maps them to customer ids, and finds failed payments", async () => {
    const stripe = fakeStripe();
    const source = stripeReadOnly({ apiKey: KEY, apiBase: stripe.base });
    const snapshot = await source.snapshot();
    expect(snapshot).toEqual({
      subscriptions: [
        {
          id: "sub_1",
          customerId: "demo-shop",
          status: "active",
          cancelAtPeriodEnd: false,
          currentPeriodEnd: new Date((T + 86_400 * 20) * 1000).toISOString(),
          amountCents: 4900,
          currency: "EUR",
          interval: "month",
        },
        {
          id: "sub_2",
          customerId: "stripe-cus_2",
          status: "past_due",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: new Date((T + 86_400 * 3) * 1000).toISOString(),
          amountCents: 9800,
          currency: "EUR",
          interval: "month",
        },
      ],
      failed: [
        {
          invoiceId: "in_1",
          customerId: "demo-shop",
          amountDueCents: 4900,
          currency: "EUR",
          attempts: 2,
          nextAttempt: new Date((T + 86_400) * 1000).toISOString(),
          at: new Date((T - 86_400) * 1000).toISOString(),
        },
      ],
    });
    // Only reads, and only these lists.
    expect(stripe.seen.every((line) => line.startsWith("GET /v1/"))).toBe(true);
    expect(stripe.seen).toContain("GET /v1/subscriptions?status=all&limit=100");
    expect(stripe.seen).toContain(
      "GET /v1/checkout/sessions?status=complete&limit=100",
    );
    expect(stripe.seen).toContain("GET /v1/invoices?status=open&limit=100");
  });

  test("a wrong key fails loudly, and health says down", async () => {
    const stripe = fakeStripe();
    const source = stripeReadOnly({ apiKey: "rk_wrong", apiBase: stripe.base });
    await expect(source.snapshot()).rejects.toThrow("Stripe answered 401");
    expect(await source.health()).toEqual({ up: false, detail: "HTTP 401" });
    expect(
      (await stripeReadOnly({ apiKey: KEY, apiBase: stripe.base }).health()).up,
    ).toBe(true);
  });
});

describe("the Billing page", () => {
  test("shows failed payments first, then subscriptions with renewals; Overview counts failed payments", async () => {
    const t = testBoard();
    current = t;
    t.sources.stripeConnected = true;
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", "correct horse battery", t.code("maria"));
    const page = (await browser.get("/billing")).text;
    expect(page).toContain("Failed payments <small>(1)</small>");
    expect(page).toMatch(
      /<a href="\/customers\/demo-taverna">demo-taverna<\/a><\/td><td>EUR 98.00<\/td><td>2<\/td>/,
    );
    const states = [
      ...page.matchAll(/<span class="tag (\w+)">([^<]+)<\/span>/g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(states).toEqual([
      "bad past due",
      "ok active",
      "warn ends at period end",
    ]);
    expect(page).toContain("<code>stripe-cus_DEMO1</code>");
    expect(page).not.toContain("@");
    const overview = (await browser.get("/")).text;
    expect(overview).toContain(
      '<span class="n">1</span><a href="/billing">Failed payments</a>',
    );
    expect(overview).toContain('<span class="tag ok">Up</span> Stripe');
  });

  test("without a key, says Stripe is not connected", async () => {
    const t = testBoard();
    current = t;
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", "correct horse battery", t.code("maria"));
    expect((await browser.get("/billing")).text).toContain(
      "Stripe is not connected yet.",
    );
    expect((await browser.get("/")).text).not.toContain("Failed payments");
  });
});
