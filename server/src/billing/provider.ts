import type { SubscriptionStatus } from "../../../shared/plans";

/**
 * What a payment provider told us, in the terms Ark uses and nobody else's.
 *
 * Each provider adapter turns its own events into these, so everything past the adapter (the webhook
 * handler, the account store, the tests) is the same whichever provider is chosen. Choosing one is
 * open question 2 in docs/ark/01-product-decisions.md.
 */
export type BillingEvent = {
  /** The provider's own id for this delivery. A repeat of it is ignored. */
  eventId: string;
  /** Free text for the record, e.g. "subscription.updated". */
  type: string;
  /** Present when the provider echoes back what we put in the checkout. Preferred over customer id. */
  tenantId?: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  planId?: string;
  status?: SubscriptionStatus;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
};

export type CheckoutRequest = {
  tenantId: string;
  planId: string;
  email: string;
  /** Where the provider sends the customer back to, as an absolute address on this deployment. */
  returnUrl: string;
};

export class BillingUnavailableError extends Error {
  constructor(message = "Payments are not set up on this deployment yet.") {
    super(message);
    this.name = "BillingUnavailableError";
  }
}

export class BillingSignatureError extends Error {
  constructor() {
    super("That billing notification could not be verified.");
    this.name = "BillingSignatureError";
  }
}

export type BillingProvider = {
  /** Stored on the subscription, so a record always says whose it is. */
  readonly id: string;
  /** Start a purchase and return where the customer pays. */
  createCheckout: (request: CheckoutRequest) => Promise<{ url: string }>;
  /** Where the customer manages cards and invoices, if the provider has such a place. */
  createPortal?: (
    providerCustomerId: string,
    returnUrl: string,
  ) => Promise<{ url: string }>;
  /** Stop renewing at the end of the paid period (or at once). */
  cancel?: (
    providerSubscriptionId: string,
    options: { atPeriodEnd: boolean },
  ) => Promise<void>;
  /**
   * Check a webhook delivery really came from the provider, and read it.
   *
   * Throws {@link BillingSignatureError} when it did not. The raw body is passed untouched because a
   * signature is over the exact bytes.
   */
  parseWebhook: (
    headers: Headers,
    rawBody: string,
  ) => Promise<BillingEvent[]> | BillingEvent[];
};
