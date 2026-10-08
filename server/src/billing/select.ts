import { manualBilling } from "./manual";
import type { BillingProvider } from "./provider";
import { sandboxBilling } from "./sandbox";

/**
 * Which payment provider this deployment uses, by name.
 *
 * `manual` (the default) takes no money. `sandbox` is a stand-in with real signature checks and no
 * payment; it refuses to start without a secret, so it cannot be turned on by accident half-configured.
 * A real provider is added here when one is chosen.
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
    return sandboxBilling({ secret, checkoutBase: `${base}/billing/sandbox` });
  }
  throw new Error(
    `ARK_BILLING_PROVIDER=${name} is not a billing provider this version knows. Use manual or sandbox.`,
  );
}
