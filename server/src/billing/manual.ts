import {
  type BillingProvider,
  BillingUnavailableError,
  BillingSignatureError,
} from "./provider";

/**
 * No payment provider: plans are set by hand by staff.
 *
 * What a deployment runs on until a provider is chosen, and always right for our own staff and for a
 * customer paying by invoice. It refuses every purchase with a sentence rather than pretending.
 */
export const manualBilling: BillingProvider = {
  id: "manual",
  async createCheckout() {
    throw new BillingUnavailableError(
      "Online payment is not available yet. Contact us to start a plan.",
    );
  },
  parseWebhook() {
    // Nothing legitimate ever calls this one.
    throw new BillingSignatureError();
  },
};
