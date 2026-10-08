import { manualBilling } from "./manual";
import { type PaddleEnvironment, paddleBilling } from "./paddle";
import type { BillingProvider } from "./provider";
import { sandboxBilling } from "./sandbox";

/**
 * Which payment provider this deployment uses, by name.
 *
 * `manual` (the default) takes no money. `sandbox` is a stand-in with real signature checks and no
 * payment; it refuses to start without a secret, so it cannot be turned on by accident half-configured.
 * `paddle` is the real one (Paddle Billing, decided 2026-10-08); it refuses to start unless every setting it needs is present and consistent.
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
  throw new Error(
    `ARK_BILLING_PROVIDER=${name} is not a billing provider this version knows. Use manual, paddle or sandbox.`,
  );
}
