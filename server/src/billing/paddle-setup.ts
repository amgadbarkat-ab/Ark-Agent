import { type Plan, purchasablePlans } from "../../../shared/plans";

/**
 * Create what Ark needs in a Paddle account, once, and say what it made.
 *
 * Done from the plan table in `shared/plans.ts`, so a price in Paddle cannot start out different from
 * the price the plan screen shows. Safe to run again: everything it creates is tagged in Paddle's
 * `custom_data`, and a second run finds those instead of making more. It NEVER changes a price that
 * already exists: changing what an existing subscriber pays is a decision, not a side effect, so a
 * price that differs from the table is reported as `drift` and left alone.
 *
 * Needs an API key with `product.write`, `price.write` and `notification_setting.write`, which is more
 * than the running server is given (that one holds `transaction.write`, `subscription.write` and
 * `customer_portal_session.write`). Make it for this and revoke it afterwards.
 *
 * What it cannot do: create the client-side token (public, made on Paddle's Authentication page), and
 * approve the checkout domain (Paddle does that). Both are listed in docs/ark/12-paddle.md.
 */

export type PaddleEnvironment = "sandbox" | "production";

const API: Record<PaddleEnvironment, string> = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
};

/** The events the server acts on (`server/src/billing/webhook.ts`). */
export const SUBSCRIBED_EVENTS = [
  "subscription.created",
  "subscription.activated",
  "subscription.updated",
  "subscription.past_due",
  "subscription.canceled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.trialing",
  "subscription.imported",
] as const;

export type PaddleSetupResult = {
  productId: string;
  /** Price id by plan, for `PADDLE_PRICE_<PLAN>`. */
  prices: Record<string, string>;
  /** What was made in this run, as opposed to found. */
  created: string[];
  /** Prices whose amount in Paddle is not the amount in the plan table. Left alone. */
  drift: { plan: string; paddleCents: number; tableCents: number }[];
  notification: {
    id: string;
    created: boolean;
    /** Only when Paddle returns it, which it does when the destination is made. Never log it. */
    secret?: string;
  };
};

type Json = Record<string, unknown>;

export async function setupPaddle(options: {
  apiKey: string;
  environment: PaddleEnvironment;
  /** Where Paddle posts events: `https://<address>/api/billing/webhook/paddle`. */
  webhookUrl: string;
  plans?: readonly Plan[];
  fetchImpl?: typeof fetch;
}): Promise<PaddleSetupResult> {
  const { apiKey, environment, webhookUrl } = options;
  const plans = options.plans ?? purchasablePlans();
  const fetchImpl = options.fetchImpl ?? fetch;

  const sandbox = environment === "sandbox";
  if (!apiKey.startsWith(sandbox ? "pdl_sdbx_apikey_" : "pdl_live_apikey_")) {
    throw new Error(
      `The API key is not a ${sandbox ? "sandbox" : "live"} key for PADDLE_ENVIRONMENT=${environment}. Nothing was created.`,
    );
  }
  if (new URL(webhookUrl).protocol !== "https:") {
    throw new Error("The notification address must be https.");
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: Json,
  ): Promise<Json> {
    const response = await fetchImpl(`${API[environment]}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      // A non-JSON body is reported by status below.
    }
    if (!response.ok) {
      const error = parsed.error as
        | { detail?: string; code?: string }
        | undefined;
      // The detail is Paddle's sentence about the request; it never contains our key.
      throw new Error(
        `Paddle refused ${method} ${path} (${response.status}): ${error?.detail ?? error?.code ?? "no reason given"}`,
      );
    }
    return parsed;
  }

  const rows = (value: unknown): Json[] =>
    Array.isArray(value) ? (value as Json[]) : [];
  const tagged = (row: Json, key: string, value: string) =>
    (row.custom_data as Json | null | undefined)?.[key] === value;

  const created: string[] = [];

  // 1. The product.
  const products = rows((await call("GET", "/products?per_page=200")).data);
  let product = products.find(
    (row) => tagged(row, "ark", "product") && row.status !== "archived",
  );
  if (!product) {
    product = (
      (await call("POST", "/products", {
        name: "Ark",
        description: "Digital employees that work for you.",
        tax_category: "standard",
        custom_data: { ark: "product" },
      })) as { data: Json }
    ).data;
    created.push("product");
  }
  const productId = String(product.id);

  // 2. One monthly price per plan.
  const existing = rows(
    (await call("GET", `/prices?product_id=${productId}&per_page=200`)).data,
  );
  const prices: Record<string, string> = {};
  const drift: PaddleSetupResult["drift"] = [];
  for (const plan of plans) {
    const found = existing.find(
      (row) => tagged(row, "ark_plan", plan.id) && row.status !== "archived",
    );
    if (found) {
      prices[plan.id] = String(found.id);
      const paddleCents = Number(
        (found.unit_price as { amount?: string } | undefined)?.amount,
      );
      if (paddleCents !== plan.priceEurCents) {
        drift.push({
          plan: plan.id,
          paddleCents,
          tableCents: plan.priceEurCents,
        });
      }
      continue;
    }
    const price = (
      (await call("POST", "/prices", {
        product_id: productId,
        description: plan.name,
        name: plan.name,
        unit_price: {
          amount: String(plan.priceEurCents),
          currency_code: "EUR",
        },
        billing_cycle: { interval: "month", frequency: 1 },
        // Whether the shown price includes tax is the account's setting, chosen once in Paddle.
        tax_mode: "account_setting",
        custom_data: { ark_plan: plan.id },
      })) as { data: Json }
    ).data;
    prices[plan.id] = String(price.id);
    created.push(`price:${plan.id}`);
  }

  // 3. Where Paddle sends events.
  const settings = rows((await call("GET", "/notification-settings")).data);
  let setting = settings.find((row) => row.destination === webhookUrl);
  let madeSetting = false;
  if (!setting) {
    setting = (
      (await call("POST", "/notification-settings", {
        description: "Ark",
        destination: webhookUrl,
        type: "url",
        subscribed_events: [...SUBSCRIBED_EVENTS],
        include_sensitive_fields: false,
        traffic_source: "all",
      })) as { data: Json }
    ).data;
    madeSetting = true;
    created.push("notification");
  }
  const secret =
    typeof setting.endpoint_secret_key === "string"
      ? setting.endpoint_secret_key
      : undefined;

  return {
    productId,
    prices,
    created,
    drift,
    notification: {
      id: String(setting.id),
      created: madeSetting,
      ...(secret ? { secret } : {}),
    },
  };
}
