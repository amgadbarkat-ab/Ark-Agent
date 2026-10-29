import { createHmac, timingSafeEqual } from "node:crypto";
import type { SubscriptionStatus } from "../../../shared/plans";
import {
  type BillingEvent,
  type BillingProvider,
  BillingSignatureError,
  BillingUnavailableError,
} from "./provider";

/**
 * Stripe, as a payment provider, next to Paddle.
 *
 * Paddle stays the provider Ark chose (it is the merchant of record and files the VAT; see
 * docs/ark/12-paddle.md). Stripe is here for a deployment that already sells through Stripe and
 * handles its own tax, and is chosen only by `ARK_BILLING_PROVIDER=stripe`. Prices live in Stripe, as
 * "price_..." ids, one per plan; this file never writes an amount.
 *
 * What it does, against Stripe's documented API (https://docs.stripe.com/api):
 * - **Checkout.** A Checkout Session in subscription mode for the plan's price. Our account id goes
 *   on the session (`client_reference_id`) and on the subscription it makes (`metadata`), which is how
 *   a notification finds the account. The customer pays on Stripe's own hosted page, so unlike Paddle
 *   there is no page of ours with a third-party script on it.
 * - **Notifications.** Verifies `Stripe-Signature` (HMAC-SHA256 of `<t>.<raw body>`), then for a
 *   `customer.subscription.*` or `checkout.session.completed` event asks Stripe for the subscription
 *   as it is NOW and reports that. Stripe's timestamps are whole seconds and its deliveries come out of
 *   order, so a `created` (incomplete) and an `updated` (active) from the same second cannot be put in
 *   order from the events themselves; reading the current state, stamped with the moment it was asked
 *   for, makes the newest answer win by construction. Everything else is ignored.
 * - **Plan change, cancel, billing portal**, each one or two calls.
 *
 * Not done: charging for what was used (`charge`, the cloud add-on). That stays Paddle's, and a Stripe
 * deployment that turns metered cloud running on finds each month left pending with a sentence saying
 * there is nothing to charge it to. See docs/ark/26-stripe.md.
 */

export type StripeEnvironment = "test" | "live";

export type StripeConfig = {
  /** "sk_test_..." / "rk_test_..." (or the live ones). Whether it is test or live is in the key itself. */
  secretKey: string;
  /** The webhook endpoint's signing secret, "whsec_...". */
  webhookSecret: string;
  /** Stripe price id for each plan we sell. */
  prices: Readonly<Record<string, string>>;
  /** How far a notification's timestamp may be from now. Replays are also stopped by event id. */
  toleranceSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const API = "https://api.stripe.com";
/**
 * The API version every request is made with, so the shape of what comes back does not change when
 * somebody upgrades the account's default in Stripe's dashboard. The reader below copes with the
 * shapes either side of 2025-03-31 anyway (the billing period moved onto the subscription's items).
 */
export const STRIPE_API_VERSION = "2025-03-31.basil";
/** Where Stripe's hosted checkout lives. A custom checkout domain would have to be added here. */
const CHECKOUT_HOST = "checkout.stripe.com";

const REQUEST_TIMEOUT_MS = 15_000;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const PRICE_ID = /^price_[A-Za-z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Test or live, from the key. Stripe keys are bound to one mode, so this is read, not guessed. */
export function stripeEnvironmentOf(
  secretKey: string,
): StripeEnvironment | undefined {
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(secretKey);
  return match ? (match[1] as StripeEnvironment) : undefined;
}

/** What goes wrong with a configuration, in words an operator can act on. Empty means it is fine. */
export function stripeConfigProblems(config: StripeConfig): string[] {
  const problems: string[] = [];
  if (!stripeEnvironmentOf(config.secretKey)) {
    problems.push(
      'STRIPE_SECRET_KEY is not a Stripe secret or restricted key ("sk_test_...", "rk_test_..." or the live ones).',
    );
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(config.webhookSecret)) {
    problems.push(
      'STRIPE_WEBHOOK_SECRET is not a webhook signing secret ("whsec_...").',
    );
  }
  const seen = new Map<string, string>();
  for (const [plan, price] of Object.entries(config.prices)) {
    if (!PRICE_ID.test(price)) {
      problems.push(
        `The price for plan "${plan}" is not a Stripe price id ("price_...").`,
      );
    }
    // One price for two plans would make a notification's plan a coin toss.
    const other = seen.get(price);
    if (other) {
      problems.push(`Plans "${other}" and "${plan}" have the same price.`);
    }
    seen.set(price, plan);
  }
  if (Object.keys(config.prices).length === 0) {
    problems.push(
      "No plan has a Stripe price. Set STRIPE_PRICE_AGENT and the others.",
    );
  }
  return problems;
}

/**
 * Stripe's subscription status, in ours.
 *
 * `unpaid` is a subscription whose retries have run out, and `paused` one that is not being billed;
 * neither may run, so both read as ended. `incomplete_expired` is a first payment that never happened.
 */
export function statusFromStripe(
  status: unknown,
): SubscriptionStatus | undefined {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "incomplete":
      return "incomplete";
    case "canceled":
    case "unpaid":
    case "paused":
    case "incomplete_expired":
      return "canceled";
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Stripe takes form-encoded bodies with nested keys: `a[b][0][c]=v`. */
export function formEncode(value: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, item: unknown) => {
    if (item === undefined || item === null) return;
    if (Array.isArray(item)) {
      for (const [index, entry] of item.entries()) {
        walk(`${prefix}[${index}]`, entry);
      }
      return;
    }
    if (typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        walk(prefix ? `${prefix}[${key}]` : key, entry);
      }
      return;
    }
    out.append(prefix, String(item));
  };
  walk("", value);
  return out.toString();
}

/** A unix time in seconds, as a date, or nothing. */
function fromUnix(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000)
    : undefined;
}

export function stripeBilling(config: StripeConfig): BillingProvider {
  const problems = stripeConfigProblems(config);
  if (problems.length > 0) {
    throw new Error(
      `Stripe is not configured correctly. ${problems.join(" ")}`,
    );
  }
  const environment = stripeEnvironmentOf(
    config.secretKey,
  ) as StripeEnvironment;
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const tolerance = config.toleranceSeconds ?? 300;
  const planForPrice = new Map(
    Object.entries(config.prices).map(([plan, price]) => [price, plan]),
  );

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
          ...(body === undefined
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(body === undefined ? {} : { body: formEncode(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BillingUnavailableError(
        "The payment service could not be reached. Try again in a minute.",
        { cause: error },
      );
    }
    if (!response.ok) {
      // What Stripe said stays out of what the customer reads, but is kept for the operator.
      const detail = await response.text().catch(() => "");
      throw new BillingUnavailableError(
        "The payment service refused that. Try again, or contact us.",
        {
          cause: new Error(
            `Stripe ${response.status}: ${detail.slice(0, 500)}`,
          ),
        },
      );
    }
    return asRecord(await response.json().catch(() => ({}))) ?? {};
  }

  function priceFor(planId: string): string {
    const price = config.prices[planId];
    if (!price) {
      throw new BillingUnavailableError(
        "That plan cannot be bought online yet. Contact us.",
      );
    }
    return price;
  }

  function itemsOf(subscription: Record<string, unknown>) {
    const items = asRecord(subscription.items)?.data;
    return (Array.isArray(items) ? items : [])
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => !!item);
  }

  function priceIdOf(item: Record<string, unknown>): string | undefined {
    const price = item.price;
    if (typeof price === "string") return price;
    const id = asRecord(price)?.id;
    return typeof id === "string" ? id : undefined;
  }

  /** The subscription, as Stripe says it is now. The id is checked before it goes into a path. */
  async function subscription(id: string) {
    if (!SUBSCRIPTION_ID.test(id)) return undefined;
    return call("GET", `/v1/subscriptions/${id}`);
  }

  function eventFrom(
    envelope: { id: string; type: string },
    current: Record<string, unknown>,
    askedAt: string,
    fallbackTenant: string | undefined,
  ): BillingEvent {
    const metadata = asRecord(current.metadata);
    const tenantId =
      typeof metadata?.tenant_id === "string" && UUID.test(metadata.tenant_id)
        ? metadata.tenant_id
        : fallbackTenant;
    const items = itemsOf(current);
    let planId: string | undefined;
    for (const item of items) {
      const priceId = priceIdOf(item);
      const found = priceId ? planForPrice.get(priceId) : undefined;
      if (found) {
        planId = found;
        break;
      }
    }
    const customer =
      typeof current.customer === "string"
        ? current.customer
        : asRecord(current.customer)?.id;
    const status = statusFromStripe(current.status);
    // On the subscription before 2025-03-31, on each of its items since.
    const periodEnd =
      fromUnix(current.current_period_end) ??
      fromUnix(items[0]?.current_period_end);
    return {
      eventId: envelope.id,
      type: envelope.type,
      ...(tenantId ? { tenantId } : {}),
      ...(typeof customer === "string" && CUSTOMER_ID.test(customer)
        ? { providerCustomerId: customer }
        : {}),
      ...(typeof current.id === "string"
        ? { providerSubscriptionId: current.id }
        : {}),
      ...(planId ? { planId } : {}),
      ...(status ? { status } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      // Either way of scheduling an end counts; one that has already ended is not "scheduled".
      cancelAtPeriodEnd:
        status !== "canceled" &&
        (current.cancel_at_period_end === true ||
          typeof current.cancel_at === "number"),
      occurredAt: askedAt,
    };
  }

  return {
    id: "stripe",
    environment,

    async createCheckout(request) {
      const success = new URL(request.returnUrl);
      success.searchParams.set("paid", "1");
      const session = await call("POST", "/v1/checkout/sessions", {
        mode: "subscription",
        line_items: [{ price: priceFor(request.planId), quantity: 1 }],
        success_url: success.toString(),
        cancel_url: request.returnUrl,
        client_reference_id: request.tenantId,
        // Prefilled when it looks like an address; Stripe refuses the whole session over a bad one.
        ...(EMAIL.test(request.email) ? { customer_email: request.email } : {}),
        metadata: { tenant_id: request.tenantId, plan_id: request.planId },
        // Copied onto the subscription, so every later notice about it carries the account.
        subscription_data: {
          metadata: { tenant_id: request.tenantId, plan_id: request.planId },
        },
      });
      const url = session.url;
      if (typeof url !== "string") {
        throw new BillingUnavailableError(
          "The payment service gave no checkout page. Try again, or contact us.",
        );
      }
      // The customer is sent wherever this says, so it has to be Stripe's own page, whatever came back.
      let address: URL;
      try {
        address = new URL(url);
      } catch {
        throw new BillingUnavailableError(
          "The payment service sent an unexpected address. Contact us.",
        );
      }
      if (address.protocol !== "https:" || address.hostname !== CHECKOUT_HOST) {
        throw new BillingUnavailableError(
          "The payment service sent an unexpected address. Contact us.",
        );
      }
      return { url };
    },

    async createPortal(customerId, returnUrl) {
      if (!CUSTOMER_ID.test(customerId)) {
        throw new BillingUnavailableError(
          "There is no billing page for this account.",
        );
      }
      const session = await call("POST", "/v1/billing_portal/sessions", {
        customer: customerId,
        return_url: returnUrl,
      });
      if (
        typeof session.url !== "string" ||
        !session.url.startsWith("https://")
      ) {
        throw new BillingUnavailableError(
          "There is no billing page for this account.",
        );
      }
      return { url: session.url };
    },

    async cancel(subscriptionId, options) {
      if (!SUBSCRIPTION_ID.test(subscriptionId)) {
        throw new BillingUnavailableError(
          "There is no subscription to cancel.",
        );
      }
      if (options.atPeriodEnd) {
        await call("POST", `/v1/subscriptions/${subscriptionId}`, {
          cancel_at_period_end: true,
        });
      } else {
        await call("DELETE", `/v1/subscriptions/${subscriptionId}`);
      }
    },

    async changePlan(subscriptionId, planId, options) {
      if (!SUBSCRIPTION_ID.test(subscriptionId)) {
        throw new BillingUnavailableError(
          "There is no subscription to change.",
        );
      }
      const price = priceFor(planId);
      const current = await call("GET", `/v1/subscriptions/${subscriptionId}`);
      /*
       * Stripe changes a price by naming the item it replaces. Without the item's id the new price is
       * added beside the old one, and the customer pays for both.
       */
      const items = itemsOf(current);
      const ours =
        items.find((item) => {
          const priceId = priceIdOf(item);
          return priceId !== undefined && planForPrice.has(priceId);
        }) ?? (items.length === 1 ? items[0] : undefined);
      const itemId = ours?.id;
      if (typeof itemId !== "string" || !/^si_[A-Za-z0-9]+$/.test(itemId)) {
        throw new BillingUnavailableError(
          "This subscription cannot be changed online. Contact us.",
        );
      }
      await call("POST", `/v1/subscriptions/${subscriptionId}`, {
        items: [{ id: itemId, price }],
        ...(options.upgrade
          ? {
              // Paying more is invoiced now, prorated; if the card is refused, nothing changes.
              proration_behavior: "always_invoice",
              payment_behavior: "pending_if_incomplete",
            }
          : {
              // Paying less is settled on the next invoice, as a prorated credit.
              proration_behavior: "create_prorations",
            }),
      });
    },

    async parseWebhook(headers, rawBody) {
      const header = headers.get("stripe-signature") ?? "";
      let timestamp: string | undefined;
      const offered: string[] = [];
      for (const part of header.split(",")) {
        const at = part.indexOf("=");
        if (at < 0) continue;
        const key = part.slice(0, at).trim();
        const value = part.slice(at + 1).trim();
        if (key === "t") timestamp = value;
        // v0 is Stripe's test-only scheme and is never accepted.
        if (key === "v1") offered.push(value);
      }
      if (!timestamp || !/^\d{1,12}$/.test(timestamp) || offered.length === 0) {
        throw new BillingSignatureError();
      }
      if (Math.abs(now() / 1000 - Number(timestamp)) > tolerance) {
        throw new BillingSignatureError();
      }
      const expected = Buffer.from(
        createHmac("sha256", config.webhookSecret)
          .update(`${timestamp}.${rawBody}`)
          .digest("hex"),
      );
      // Several v1 values arrive while a secret is being rolled; any one that matches is enough.
      const genuine = offered.some((candidate) => {
        const got = Buffer.from(candidate);
        return got.length === expected.length && timingSafeEqual(got, expected);
      });
      if (!genuine) throw new BillingSignatureError();

      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = asRecord(JSON.parse(rawBody));
      } catch {
        throw new BillingSignatureError();
      }
      const type = envelope?.type;
      const eventId = envelope?.id;
      if (typeof type !== "string" || typeof eventId !== "string") return [];
      // A test event at a live deployment, or the reverse, is somebody's mistake, not a payment.
      if (envelope?.livemode !== (environment === "live")) return [];
      const object = asRecord(asRecord(envelope?.data)?.object);
      if (!object) return [];

      let subscriptionId: string | undefined;
      let fallbackTenant: string | undefined;
      if (type.startsWith("customer.subscription.")) {
        if (typeof object.id === "string") subscriptionId = object.id;
      } else if (
        type === "checkout.session.completed" ||
        type === "checkout.session.async_payment_succeeded"
      ) {
        if (object.mode !== "subscription") return [];
        if (typeof object.subscription === "string") {
          subscriptionId = object.subscription;
        }
        if (
          typeof object.client_reference_id === "string" &&
          UUID.test(object.client_reference_id)
        ) {
          fallbackTenant = object.client_reference_id;
        }
      } else {
        // Invoices, customers, prices: a subscription notice follows whatever matters among them.
        return [];
      }
      if (!subscriptionId || !SUBSCRIPTION_ID.test(subscriptionId)) return [];

      /*
       * Asked for now rather than taken from the event (see the top of this file). The moment is
       * taken BEFORE asking, so whatever comes back is at least that new. If Stripe cannot be reached
       * this throws, the delivery is answered with an error and nothing is recorded, and Stripe's
       * retry gets another go.
       */
      const askedAt = new Date(now()).toISOString();
      const current = await subscription(subscriptionId);
      if (!current) return [];
      return [
        eventFrom({ id: eventId, type }, current, askedAt, fallbackTenant),
      ];
    },
  };
}
