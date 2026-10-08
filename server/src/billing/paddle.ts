import { createHmac, timingSafeEqual } from "node:crypto";
import type { SubscriptionStatus } from "../../../shared/plans";
import {
  type BillingEvent,
  type BillingProvider,
  BillingSignatureError,
  BillingChargeUncertain,
  BillingUnavailableError,
} from "./provider";

/**
 * Paddle Billing, as a payment provider.
 *
 * Paddle is the merchant of record: it sells to our customers in its own name, collects and pays the
 * VAT and sales tax, and sends the invoices. That is why it was chosen over a processor that would
 * leave us to register for tax in every country (decision, 2026-10-08). Prices live in Paddle, as
 * "pri_..." ids, one per plan; this file never writes an amount.
 *
 * What it does, against Paddle's documented Billing API (https://developer.paddle.com):
 * - **Checkout.** Creates a transaction for the plan's price and carries our account id in
 *   `custom_data`. The customer pays on Paddle.js, opened by our own page (`checkoutPage`), because
 *   Paddle's checkout is a script and its hosted payment link needs a page of ours with that script.
 * - **Notifications.** Verifies `Paddle-Signature` (HMAC-SHA256 of `<ts>:<raw body>`) and turns
 *   `subscription.*` events into {@link BillingEvent}s. Everything else is ignored.
 * - **Plan change, cancel, billing portal**, each one call.
 *
 * Not tested against Paddle itself: no Paddle account was available when this was written. It is
 * tested against a fake Paddle that follows the documentation, and the first real run belongs in
 * Paddle's sandbox before any live key is configured. See docs/ark/12-paddle.md.
 */

export type PaddleEnvironment = "sandbox" | "production";

export type PaddleConfig = {
  apiKey: string;
  /** The notification destination's secret, "pdl_ntfset_...". */
  webhookSecret: string;
  /** The client-side token for Paddle.js ("test_..." or "live_..."). Public by design. */
  clientToken: string;
  environment: PaddleEnvironment;
  /** Paddle price id for each plan we sell. */
  prices: Readonly<Record<string, string>>;
  /** Our checkout page, absolute. It must be an approved domain in Paddle. */
  checkoutUrl: string;
  /**
   * The Paddle product that usage charges (a month of cloud running) are filed under, "pro_...".
   * Absent means usage cannot be charged, which `charge` says rather than guesses.
   */
  cloudProductId?: string;
  /** How far a notification's timestamp may be from now. Replays are also stopped by event id. */
  toleranceSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const API: Record<PaddleEnvironment, string> = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
};

const REQUEST_TIMEOUT_MS = 15_000;
const SUBSCRIPTION_ID = /^sub_[a-z0-9]+$/;
const CUSTOMER_ID = /^ctm_[a-z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What goes wrong with a configuration, in words an operator can act on. Empty means it is fine. */
export function paddleConfigProblems(config: PaddleConfig): string[] {
  const problems: string[] = [];
  const sandbox = config.environment === "sandbox";
  if (
    !config.apiKey.startsWith(sandbox ? "pdl_sdbx_apikey_" : "pdl_live_apikey_")
  ) {
    problems.push(
      `PADDLE_API_KEY is not a ${sandbox ? "sandbox" : "live"} API key ("${sandbox ? "pdl_sdbx_apikey_" : "pdl_live_apikey_"}...") for PADDLE_ENVIRONMENT=${config.environment}.`,
    );
  }
  if (!config.clientToken.startsWith(sandbox ? "test_" : "live_")) {
    problems.push(
      `PADDLE_CLIENT_TOKEN is not a ${sandbox ? "sandbox" : "live"} client-side token ("${sandbox ? "test_" : "live_"}...") for PADDLE_ENVIRONMENT=${config.environment}.`,
    );
  }
  if (!/^[A-Za-z0-9_-]{10,}$/.test(config.clientToken)) {
    problems.push("PADDLE_CLIENT_TOKEN has characters a token does not.");
  }
  if (!config.webhookSecret.startsWith("pdl_ntfset_")) {
    problems.push(
      'PADDLE_WEBHOOK_SECRET is not a notification secret ("pdl_ntfset_...").',
    );
  }
  for (const [plan, price] of Object.entries(config.prices)) {
    if (!/^pri_[a-z0-9]+$/.test(price)) {
      problems.push(
        `The price for plan "${plan}" is not a Paddle price id ("pri_...").`,
      );
    }
  }
  if (
    config.cloudProductId !== undefined &&
    !/^pro_[a-z0-9]+$/.test(config.cloudProductId)
  ) {
    problems.push(
      'PADDLE_PRODUCT_CLOUD is not a Paddle product id ("pro_...").',
    );
  }
  if (Object.keys(config.prices).length === 0) {
    problems.push(
      "No plan has a Paddle price. Set PADDLE_PRICE_AGENT and the others.",
    );
  }
  try {
    const url = new URL(config.checkoutUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      problems.push("The checkout page must be served over https.");
    }
  } catch {
    problems.push("The checkout page address is not a valid address.");
  }
  return problems;
}

/** Paddle's subscription status, in ours. A paused subscription may not run, so it reads as ended. */
export function statusFromPaddle(
  status: unknown,
): SubscriptionStatus | undefined {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "paused":
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

/** The HTML our checkout page is. Everything put into the script is encoded, none of it is markup. */
function pageFor(config: PaddleConfig, successUrl: string): string {
  const encode = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
  const back = new URL(successUrl);
  back.search = "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Checkout</title>
<style>body{font:15px system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;color:#111}a{color:inherit}</style>
</head>
<body>
<p id="message">Opening checkout…</p>
<p><a id="back" href="${back.toString().replace(/"/g, "&quot;")}">Back to your plan</a></p>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
(function () {
  var plan = ${encode(back.toString())};
  var success = ${encode(successUrl)};
  if (!/[?&]_ptxn=txn_[a-z0-9]+/.test(location.search)) {
    document.getElementById("message").textContent = "There is nothing to pay for on this page.";
    return;
  }
  if (typeof Paddle === "undefined") {
    document.getElementById("message").textContent = "The payment page could not be loaded. Check your connection and try again.";
    return;
  }
  ${config.environment === "sandbox" ? 'Paddle.Environment.set("sandbox");' : ""}
  Paddle.Initialize({
    token: ${encode(config.clientToken)},
    checkout: { settings: { displayMode: "overlay", successUrl: success } },
    eventCallback: function (event) {
      if (event && event.name === "checkout.closed") location.assign(plan);
    }
  });
})();
</script>
</body>
</html>
`;
}

export function paddleBilling(config: PaddleConfig): BillingProvider {
  const problems = paddleConfigProblems(config);
  if (problems.length > 0) {
    throw new Error(
      `Paddle is not configured correctly. ${problems.join(" ")}`,
    );
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const tolerance = config.toleranceSeconds ?? 300;
  const checkoutOrigin = new URL(config.checkoutUrl).origin;
  const planForPrice = new Map(
    Object.entries(config.prices).map(([plan, price]) => [price, plan]),
  );

  async function call(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(`${API[config.environment]}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BillingUnavailableError(
        "The payment service could not be reached. Try again in a minute.",
        { cause: error },
      );
    }
    if (!response.ok) {
      // What Paddle said stays out of what the customer reads, but is kept for the operator.
      const detail = await response.text().catch(() => "");
      throw new BillingUnavailableError(
        "The payment service refused that. Try again, or contact us.",
        {
          cause: new Error(
            `Paddle ${response.status}: ${detail.slice(0, 500)}`,
          ),
        },
      );
    }
    return (asRecord(await response.json().catch(() => ({}))) ?? {}) as Record<
      string,
      unknown
    >;
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

  return {
    id: "paddle",

    async createCheckout(request) {
      const created = await call("POST", "/transactions", {
        items: [{ price_id: priceFor(request.planId), quantity: 1 }],
        // Comes back on the subscription and on every notification about it, which is how a payment
        // finds the account it is for.
        custom_data: { tenant_id: request.tenantId, plan_id: request.planId },
        checkout: { url: config.checkoutUrl },
      });
      const url = asRecord(asRecord(created.data)?.checkout)?.url;
      if (typeof url !== "string") {
        throw new BillingUnavailableError(
          "The payment service gave no checkout page. Try again, or contact us.",
        );
      }
      // The customer is sent wherever this says, so it has to be our own page, whatever came back.
      if (new URL(url).origin !== checkoutOrigin) {
        throw new BillingUnavailableError(
          "The payment service sent an unexpected address. Contact us.",
        );
      }
      return { url };
    },

    async createPortal(customerId) {
      if (!CUSTOMER_ID.test(customerId)) {
        throw new BillingUnavailableError(
          "There is no billing page for this account.",
        );
      }
      const session = await call(
        "POST",
        `/customers/${customerId}/portal-sessions`,
        {},
      );
      const overview = asRecord(
        asRecord(asRecord(session.data)?.urls)?.general,
      )?.overview;
      if (typeof overview !== "string" || !overview.startsWith("https://")) {
        throw new BillingUnavailableError(
          "There is no billing page for this account.",
        );
      }
      return { url: overview };
    },

    async cancel(subscriptionId, options) {
      if (!SUBSCRIPTION_ID.test(subscriptionId)) {
        throw new BillingUnavailableError(
          "There is no subscription to cancel.",
        );
      }
      await call("POST", `/subscriptions/${subscriptionId}/cancel`, {
        effective_from: options.atPeriodEnd
          ? "next_billing_period"
          : "immediately",
      });
    },

    async charge(subscriptionId, request) {
      if (!SUBSCRIPTION_ID.test(subscriptionId)) {
        throw new BillingUnavailableError(
          "There is no subscription to charge.",
        );
      }
      if (!config.cloudProductId) {
        throw new BillingUnavailableError(
          "Usage charges are not set up with the payment service (PADDLE_PRODUCT_CLOUD).",
        );
      }
      if (
        !Number.isInteger(request.amountCents) ||
        request.amountCents < 1 ||
        request.amountCents > 1_000_000
      ) {
        throw new BillingUnavailableError(
          "That is not an amount that can be charged.",
        );
      }
      /*
       * NOT `call`. Everything `call` throws is "try again", and for a charge that is the one
       * answer that must not be given when it is not known to be true. A request that was sent and
       * never answered may have been taken, and asking again takes the money twice.
       *
       * `external` tax mode: the amount is what Ark must receive to cover its cost, with tax added on
       * top for the customer. Left to the account's own setting it might be "tax included", and then
       * the tax would come out of an amount that was worked out to cover costs.
       */
      let response: Response;
      try {
        response = await fetchImpl(
          `${API[config.environment]}/subscriptions/${subscriptionId}/charge`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              effective_from: "immediately",
              // If the card is refused, nothing is applied and nothing is taken: a definite no.
              on_payment_failure: "prevent_change",
              items: [
                {
                  quantity: 1,
                  price: {
                    description: request.description,
                    name: "Ark cloud running",
                    product_id: config.cloudProductId,
                    unit_price: {
                      amount: String(request.amountCents),
                      currency_code: "EUR",
                    },
                    tax_mode: "external",
                  },
                },
              ],
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } catch (error) {
        throw new BillingChargeUncertain({ cause: error });
      }
      if (response.ok) {
        return { reference: `paddle:${subscriptionId}:${request.description}` };
      }
      const detail = await response.text().catch(() => "");
      const refused = new BillingUnavailableError(
        "The payment service refused that charge.",
        {
          cause: new Error(
            `Paddle ${response.status}: ${detail.slice(0, 500)}`,
          ),
        },
      );
      // A client error is a definite no. Anything else (a server error) may have happened.
      if (response.status >= 400 && response.status < 500) throw refused;
      throw new BillingChargeUncertain({ cause: refused });
    },

    async changePlan(subscriptionId, planId, options) {
      if (!SUBSCRIPTION_ID.test(subscriptionId)) {
        throw new BillingUnavailableError(
          "There is no subscription to change.",
        );
      }
      await call("PATCH", `/subscriptions/${subscriptionId}`, {
        items: [{ price_id: priceFor(planId), quantity: 1 }],
        // Paying more starts now, paying less is settled at the next renewal.
        proration_billing_mode: options.upgrade
          ? "prorated_immediately"
          : "prorated_next_billing_period",
      });
    },

    checkoutPage({ successUrl }) {
      return pageFor(config, successUrl);
    },

    parseWebhook(headers, rawBody) {
      const header = headers.get("paddle-signature") ?? "";
      let ts: string | undefined;
      const offered: string[] = [];
      for (const part of header.split(";")) {
        const at = part.indexOf("=");
        if (at < 0) continue;
        const key = part.slice(0, at).trim();
        const value = part.slice(at + 1).trim();
        if (key === "ts") ts = value;
        if (key === "h1") offered.push(value);
      }
      if (!ts || !/^\d{1,12}$/.test(ts) || offered.length === 0) {
        throw new BillingSignatureError();
      }
      if (Math.abs(now() / 1000 - Number(ts)) > tolerance) {
        throw new BillingSignatureError();
      }
      const expected = Buffer.from(
        createHmac("sha256", config.webhookSecret)
          .update(`${ts}:${rawBody}`)
          .digest("hex"),
      );
      // Several h1 values arrive while Paddle rotates a secret; any one that matches is enough.
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
      const type = envelope?.event_type;
      const eventId = envelope?.event_id;
      if (
        typeof type !== "string" ||
        typeof eventId !== "string" ||
        !type.startsWith("subscription.")
      ) {
        // Transactions, customers, prices: nothing here acts on them.
        return [];
      }
      const data = asRecord(envelope?.data);
      if (!data) return [];

      const custom = asRecord(data.custom_data);
      const tenantId =
        typeof custom?.tenant_id === "string" && UUID.test(custom.tenant_id)
          ? custom.tenant_id
          : undefined;
      let planId: string | undefined;
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const entry = asRecord(item);
        const priceId = asRecord(entry?.price)?.id ?? entry?.price_id;
        const found =
          typeof priceId === "string" ? planForPrice.get(priceId) : undefined;
        if (found) {
          planId = found;
          break;
        }
      }
      const status = statusFromPaddle(data.status);
      const periodEnd = asRecord(data.current_billing_period)?.ends_at;
      const scheduled = asRecord(data.scheduled_change);

      const event: BillingEvent = {
        eventId,
        type,
        ...(tenantId ? { tenantId } : {}),
        ...(typeof data.customer_id === "string"
          ? { providerCustomerId: data.customer_id }
          : {}),
        ...(typeof data.id === "string"
          ? { providerSubscriptionId: data.id }
          : {}),
        ...(planId ? { planId } : {}),
        ...(status ? { status } : {}),
        ...(typeof periodEnd === "string" &&
        !Number.isNaN(Date.parse(periodEnd))
          ? { currentPeriodEnd: new Date(periodEnd) }
          : {}),
        // A cancellation Paddle has scheduled but not yet made. Absent means none is scheduled.
        cancelAtPeriodEnd: scheduled?.action === "cancel",
        ...(typeof envelope?.occurred_at === "string"
          ? { occurredAt: envelope.occurred_at }
          : {}),
      };
      return [event];
    },
  };
}
