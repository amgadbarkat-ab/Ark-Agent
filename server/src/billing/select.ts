import { manualBilling } from "./manual";
import { type PaddleEnvironment, paddleBilling } from "./paddle";
import type { BillingProvider } from "./provider";
import { sandboxBilling } from "./sandbox";
import { stripeBilling, stripeEnvironmentOf } from "./stripe";

/**
 * Which payment provider this deployment uses, by name.
 *
 * `manual` (the default) takes no money. `sandbox` is a stand-in with real signature checks and no
 * payment; it refuses to start without a secret, so it cannot be turned on by accident half-configured.
 * `paddle` is the real one (Paddle Billing, decided 2026-10-08); it refuses to start unless every setting it needs is present and consistent.
 * `stripe` is the alternative for a deployment that sells through Stripe and handles its own tax. It is
 * test mode only for now: a live key is refused until the live run in docs/ark/25-stripe.md is done.
 */
export function billingFromEnvironment(
  environment: Record<string, string | undefined>,
  deployment: { appUrl: string | undefined },
): BillingProvider {
  const name =
    environment.ARK_BILLING_PROVIDER?.trim().toLowerCase() || "manual";
  if (name === "manual") return manualBilling;
  if (name === "sandbox") {
    const secret = environment.ARK_BILLING_SANDBOX_SECRET?.trim();
    if (!secret || secret.length < 16) {
      throw new Error(
        "ARK_BILLING_PROVIDER=sandbox needs ARK_BILLING_SANDBOX_SECRET, at least 16 characters.",
      );
    }
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "The sandbox billing provider takes no money and is refused under NODE_ENV=production.",
      );
    }
    const base = (deployment.appUrl ?? "http://localhost:3010").replace(
      /\/+$/,
      "",
    );
    return sandboxBilling({
      secret,
      checkoutBase: `${base}/api/billing/sandbox/checkout`,
    });
  }
  if (name === "paddle") {
    const need = (key: string) => {
      const value = environment[key]?.trim();
      if (!value) {
        throw new Error(`ARK_BILLING_PROVIDER=paddle needs ${key}.`);
      }
      return value;
    };
    const apiKey = need("PADDLE_API_KEY");
    const declared = environment.PADDLE_ENVIRONMENT?.trim().toLowerCase();
    if (declared && declared !== "sandbox" && declared !== "production") {
      throw new Error("PADDLE_ENVIRONMENT is sandbox or production.");
    }
    // Said out loud rather than guessed from the key, so a live key is never used by accident.
    const paddleEnvironment: PaddleEnvironment =
      (declared as PaddleEnvironment | undefined) ??
      (apiKey.startsWith("pdl_sdbx_") ? "sandbox" : "production");
    if (!deployment.appUrl) {
      throw new Error(
        "ARK_BILLING_PROVIDER=paddle needs this deployment's public address (APP_URL), because Paddle sends customers back to a page on it.",
      );
    }
    const prices: Record<string, string> = {};
    for (const [plan, key] of [
      ["agent", "PADDLE_PRICE_AGENT"],
      ["team", "PADDLE_PRICE_TEAM"],
      ["enterprise", "PADDLE_PRICE_ENTERPRISE"],
    ] as const) {
      const value = environment[key]?.trim();
      if (value) prices[plan] = value;
    }
    const cloudProduct = environment.PADDLE_PRODUCT_CLOUD?.trim();
    const tolerance = Number(environment.PADDLE_WEBHOOK_TOLERANCE_SECONDS);
    return paddleBilling({
      apiKey,
      webhookSecret: need("PADDLE_WEBHOOK_SECRET"),
      clientToken: need("PADDLE_CLIENT_TOKEN"),
      environment: paddleEnvironment,
      prices,
      ...(cloudProduct ? { cloudProductId: cloudProduct } : {}),
      checkoutUrl: `${deployment.appUrl.replace(/\/+$/, "")}/api/billing/checkout`,
      ...(Number.isFinite(tolerance) && tolerance > 0
        ? { toleranceSeconds: tolerance }
        : {}),
    });
  }
  if (name === "stripe") {
    const need = (key: string) => {
      const value = environment[key]?.trim();
      if (!value) {
        throw new Error(`ARK_BILLING_PROVIDER=stripe needs ${key}.`);
      }
      return value;
    };
    const secretKey = need("STRIPE_SECRET_KEY");
    /*
     * Stripe has only been run against its test mode. Taking real money through it is a decision that
     * comes after the live run, not a key pasted into the wrong box, so a live key stops the server.
     */
    if (stripeEnvironmentOf(secretKey) === "live") {
      throw new Error(
        "STRIPE_SECRET_KEY is a live key, and Stripe is supported in test mode only for now. Use a test key (sk_test_... or rk_test_...); docs/ark/25-stripe.md says what is left before live.",
      );
    }
    const prices: Record<string, string> = {};
    for (const [plan, key] of [
      ["agent", "STRIPE_PRICE_AGENT"],
      ["team", "STRIPE_PRICE_TEAM"],
      ["enterprise", "STRIPE_PRICE_ENTERPRISE"],
    ] as const) {
      const value = environment[key]?.trim();
      if (value) prices[plan] = value;
    }
    const tolerance = Number(environment.STRIPE_WEBHOOK_TOLERANCE_SECONDS);
    return stripeBilling({
      secretKey,
      webhookSecret: need("STRIPE_WEBHOOK_SECRET"),
      prices,
      ...(Number.isFinite(tolerance) && tolerance > 0
        ? { toleranceSeconds: tolerance }
        : {}),
    });
  }
  throw new Error(
    `ARK_BILLING_PROVIDER=${name} is not a billing provider this version knows. Use manual, paddle, stripe or sandbox.`,
  );
}
