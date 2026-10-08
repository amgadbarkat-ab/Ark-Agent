import { describe, expect, test } from "bun:test";
import { setupPaddle } from "../src/billing/paddle-setup";

/** A Paddle that remembers what it is told, with the response shapes its API documents. */
function fakePaddle() {
  const state = {
    products: [] as Record<string, unknown>[],
    prices: [] as Record<string, unknown>[],
    settings: [] as Record<string, unknown>[],
    calls: [] as string[],
    authorizations: new Set<string>(),
  };
  let counter = 0;
  const id = (prefix: string) =>
    `${prefix}_${String(++counter).padStart(6, "0")}`;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${url.pathname}`);
    state.authorizations.add(
      new Headers(init?.headers).get("authorization") ?? "",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const ok = (data: unknown) => Response.json({ data });
    if (url.pathname === "/products") {
      if (method === "GET") return ok(state.products);
      const row = { id: id("pro"), status: "active", ...body };
      state.products.push(row);
      return ok(row);
    }
    if (url.pathname === "/prices") {
      if (method === "GET") return ok(state.prices);
      const row = { id: id("pri"), status: "active", ...body };
      state.prices.push(row);
      return ok(row);
    }
    if (url.pathname === "/notification-settings") {
      if (method === "GET") return ok(state.settings);
      const row = {
        id: id("ntfset"),
        endpoint_secret_key: "pdl_ntfset_secretvalue",
        ...body,
      };
      state.settings.push(row);
      return ok(row);
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

const KEY = "pdl_sdbx_apikey_abc";
const URL_OK = "https://ark.example.com/api/billing/webhook/paddle";

describe("setting Paddle up", () => {
  test("makes one product, a monthly price per plan from the plan table, and the notification destination", async () => {
    const paddle = fakePaddle();
    const result = await setupPaddle({
      apiKey: KEY,
      environment: "sandbox",
      webhookUrl: URL_OK,
      fetchImpl: paddle.fetchImpl,
    });

    expect(result.created).toEqual([
      "product",
      "price:agent",
      "price:team",
      "price:enterprise",
      "notification",
    ]);
    expect(Object.keys(result.prices)).toEqual(["agent", "team", "enterprise"]);
    // The amounts are the plan table's, in cents, in euro, monthly.
    const amounts = paddle.state.prices.map((p) => [
      (p.custom_data as { ark_plan: string }).ark_plan,
      (p.unit_price as { amount: string; currency_code: string }).amount,
      (p.unit_price as { amount: string; currency_code: string }).currency_code,
      (p.billing_cycle as { interval: string }).interval,
    ]);
    expect(amounts).toEqual([
      ["agent", "5000", "EUR", "month"],
      ["team", "10000", "EUR", "month"],
      ["enterprise", "25000", "EUR", "month"],
    ]);
    expect(paddle.state.settings[0]?.subscribed_events).toContain(
      "subscription.created",
    );
    expect(result.notification.secret).toBe("pdl_ntfset_secretvalue");
    expect(paddle.state.authorizations).toEqual(new Set([`Bearer ${KEY}`]));
  });

  test("a second run finds everything and makes nothing", async () => {
    const paddle = fakePaddle();
    const options = {
      apiKey: KEY,
      environment: "sandbox" as const,
      webhookUrl: URL_OK,
      fetchImpl: paddle.fetchImpl,
    };
    const first = await setupPaddle(options);
    const second = await setupPaddle(options);

    expect(second.created).toEqual([]);
    expect(second.prices).toEqual(first.prices);
    expect(paddle.state.products).toHaveLength(1);
    expect(paddle.state.prices).toHaveLength(3);
    expect(paddle.state.settings).toHaveLength(1);
  });

  test("a price that differs from the table is reported and never changed", async () => {
    const paddle = fakePaddle();
    const options = {
      apiKey: KEY,
      environment: "sandbox" as const,
      webhookUrl: URL_OK,
      fetchImpl: paddle.fetchImpl,
    };
    await setupPaddle(options);
    (
      paddle.state.prices[1] as { unit_price: { amount: string } }
    ).unit_price.amount = "9000";

    const again = await setupPaddle(options);
    expect(again.drift).toEqual([
      { plan: "team", paddleCents: 9000, tableCents: 10000 },
    ]);
    expect(paddle.state.calls.filter((c) => c.startsWith("PATCH"))).toEqual([]);
  });

  test("a live key against the sandbox, or the reverse, is refused before anything is sent", async () => {
    const paddle = fakePaddle();
    await expect(
      setupPaddle({
        apiKey: "pdl_live_apikey_abc",
        environment: "sandbox",
        webhookUrl: URL_OK,
        fetchImpl: paddle.fetchImpl,
      }),
    ).rejects.toThrow(/not a sandbox key/);
    expect(paddle.state.calls).toEqual([]);
  });

  test("an address that is not https is refused", async () => {
    await expect(
      setupPaddle({
        apiKey: KEY,
        environment: "sandbox",
        webhookUrl: "http://ark.example.com/api/billing/webhook/paddle",
        fetchImpl: fakePaddle().fetchImpl,
      }),
    ).rejects.toThrow(/https/);
  });

  test("a refusal from Paddle is reported in Paddle's words and never with the key", async () => {
    const fetchImpl = (async () =>
      Response.json(
        {
          error: {
            code: "forbidden",
            detail: "Missing permission product.write",
          },
        },
        { status: 403 },
      )) as unknown as typeof fetch;
    const failure = await setupPaddle({
      apiKey: KEY,
      environment: "sandbox",
      webhookUrl: URL_OK,
      fetchImpl,
    }).catch((error: Error) => error);
    expect(String(failure)).toContain("Missing permission product.write");
    expect(String(failure)).not.toContain(KEY);
  });
});
