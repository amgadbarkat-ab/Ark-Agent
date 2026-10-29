import { type Plan, purchasablePlans } from "../../../shared/plans";
import { formEncode, STRIPE_API_VERSION, stripeEnvironmentOf } from "./stripe";

/**
 * Create what Ark needs in a Stripe account's TEST mode, once, and say what it made.
 *
 * Done from the plan table in `shared/plans.ts`, so a price in Stripe cannot start out different from
 * the price the plan screen shows. Safe to run again: the product has a fixed id (`ark_plans`) and each
 * price a fixed lookup key (`ark_<plan>_monthly`), so a second run finds them instead of making more.
 * It NEVER changes a price that exists (Stripe prices cannot be changed anyway; a new amount is a new
 * price, and moving subscribers onto it is a decision): a price that differs from the table is reported
 * as `drift` and left alone.
 *
 * Refuses a live key, as the server does (docs/ark/26-stripe.md). The webhook endpoint is made by hand
 * in Stripe's dashboard, because its signing secret is shown once and belongs in the secret store, not
 * in a script's output.
 */

/** The events the server acts on (`parseWebhook` in stripe.ts). The endpoint subscribes to these. */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
] as const;

export const STRIPE_PRODUCT_ID = "ark_plans";

export function lookupKeyFor(planId: string): string {
  return `ark_${planId}_monthly`;
}

export type StripeSetupResult = {
  productId: string;
  /** Price id by plan, for `STRIPE_PRICE_<PLAN>`. */
  prices: Record<string, string>;
  /** What was made in this run, as opposed to found. */
  created: string[];
  /** Prices whose amount in Stripe is not the amount in the plan table. Left alone. */
  drift: { plan: string; stripeCents: number; tableCents: number }[];
};

type Json = Record<string, unknown>;

function stripeCaller(secretKey: string, fetchImpl: typeof fetch) {
  return async function call(
    method: "GET" | "POST",
    path: string,
    body?: Json,
  ): Promise<{ status: number; body: Json }> {
    const response = await fetchImpl(`https://api.stripe.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
        ...(body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(body ? { body: formEncode(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      // A non-JSON body is reported by status below.
    }
    return { status: response.status, body: parsed };
  };
}

function refusal(
  method: string,
  path: string,
  answer: { status: number; body: Json },
) {
  const error = answer.body.error as
    | { message?: string; code?: string }
    | undefined;
  // Stripe's message is about the request; it never contains our key.
  return new Error(
    `Stripe refused ${method} ${path} (${answer.status}): ${error?.message ?? error?.code ?? "no reason given"}`,
  );
}

function refuseLive(secretKey: string) {
  const environment = stripeEnvironmentOf(secretKey);
  if (environment !== "test") {
    throw new Error(
      environment === "live"
        ? "That is a live key. Stripe is set up in test mode only for now. Nothing was created."
        : "That is not a Stripe secret key (sk_test_... or rk_test_...). Nothing was created.",
    );
  }
}

export async function setupStripe(options: {
  secretKey: string;
  plans?: readonly Plan[];
  fetchImpl?: typeof fetch;
}): Promise<StripeSetupResult> {
  refuseLive(options.secretKey);
  const plans = options.plans ?? purchasablePlans();
  const call = stripeCaller(options.secretKey, options.fetchImpl ?? fetch);
  const created: string[] = [];

  // 1. The product, under a fixed id so it is found again.
  const product = await call("GET", `/v1/products/${STRIPE_PRODUCT_ID}`);
  if (product.status === 404) {
    const made = await call("POST", "/v1/products", {
      id: STRIPE_PRODUCT_ID,
      name: "Ark",
      description: "Digital employees that work for you.",
    });
    if (made.status >= 400) throw refusal("POST", "/v1/products", made);
    created.push("product");
  } else if (product.status >= 400) {
    throw refusal("GET", `/v1/products/${STRIPE_PRODUCT_ID}`, product);
  }

  // 2. One monthly EUR price per plan, found by lookup key.
  const query = new URLSearchParams({ active: "true", limit: "100" });
  for (const plan of plans)
    query.append("lookup_keys[]", lookupKeyFor(plan.id));
  const listed = await call("GET", `/v1/prices?${query}`);
  if (listed.status >= 400) throw refusal("GET", "/v1/prices", listed);
  const existing = Array.isArray(listed.body.data)
    ? (listed.body.data as Json[])
    : [];
  const prices: Record<string, string> = {};
  const drift: StripeSetupResult["drift"] = [];
  for (const plan of plans) {
    const found = existing.find(
      (row) => row.lookup_key === lookupKeyFor(plan.id),
    );
    if (found) {
      prices[plan.id] = String(found.id);
      const stripeCents = Number(found.unit_amount);
      if (stripeCents !== plan.priceEurCents || found.currency !== "eur") {
        drift.push({
          plan: plan.id,
          stripeCents,
          tableCents: plan.priceEurCents,
        });
      }
      continue;
    }
    const made = await call("POST", "/v1/prices", {
      product: STRIPE_PRODUCT_ID,
      currency: "eur",
      unit_amount: plan.priceEurCents,
      recurring: { interval: "month" },
      lookup_key: lookupKeyFor(plan.id),
      nickname: plan.name,
      metadata: { ark_plan: plan.id },
    });
    if (made.status >= 400) throw refusal("POST", "/v1/prices", made);
    prices[plan.id] = String(made.body.id);
    created.push(`price:${plan.id}`);
  }
  return { productId: STRIPE_PRODUCT_ID, prices, created, drift };
}

/**
 * Open a test checkout for one price and return its address, to prove the price can be bought.
 *
 * The same request the server makes when a customer chooses a plan, with a made-up account. Nothing is
 * paid unless somebody opens the address and pays with one of Stripe's test cards; an unopened session
 * expires by itself after a day.
 */
export async function tryStripeCheckout(options: {
  secretKey: string;
  priceId: string;
  returnUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; url: string }> {
  refuseLive(options.secretKey);
  const call = stripeCaller(options.secretKey, options.fetchImpl ?? fetch);
  const tenant = "00000000-0000-4000-8000-000000000000";
  const success = new URL(options.returnUrl);
  success.searchParams.set("paid", "1");
  const made = await call("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: options.priceId, quantity: 1 }],
    success_url: success.toString(),
    cancel_url: options.returnUrl,
    client_reference_id: tenant,
    metadata: { tenant_id: tenant, ark_setup_check: "1" },
    subscription_data: {
      metadata: { tenant_id: tenant, ark_setup_check: "1" },
    },
  });
  if (made.status >= 400) throw refusal("POST", "/v1/checkout/sessions", made);
  return { id: String(made.body.id), url: String(made.body.url) };
}
