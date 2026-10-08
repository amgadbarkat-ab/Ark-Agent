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
  /**
   * When the provider says this happened (ISO 8601). A notice older than one already applied to the
   * same account is dropped, because providers deliver late and out of order.
   */
  occurredAt?: string;
};

export type CheckoutRequest = {
  tenantId: string;
  planId: string;
  email: string;
  /** Where the provider sends the customer back to, as an absolute address on this deployment. */
  returnUrl: string;
};

export class BillingUnavailableError extends Error {
  constructor(
    message = "Payments are not set up on this deployment yet.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BillingUnavailableError";
  }
}

/**
 * The payment provider may or may not have taken a payment: it was asked, and the answer was lost
 * (a timeout, a dropped connection, a server error). The one thing that must never happen next is
 * asking again.
 */
export class BillingChargeUncertain extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The payment service did not say whether the charge went through.",
      options,
    );
    this.name = "BillingChargeUncertain";
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
  /**
   * Move an existing subscription to another plan, in place.
   *
   * Without this, choosing another plan while subscribed would start a second subscription and bill
   * the customer twice. The account changes when the provider reports the change, not when this
   * returns.
   */
  changePlan?: (
    providerSubscriptionId: string,
    planId: string,
    options: { upgrade: boolean },
  ) => Promise<void>;
  /**
   * The page the provider's checkout opens on, for a provider whose checkout is a script on the
   * seller's own page. Served at `/api/billing/checkout`.
   */
  checkoutPage?: (options: { successUrl: string }) => string;
  /** Stop renewing at the end of the paid period (or at once). */
  cancel?: (
    providerSubscriptionId: string,
    options: { atPeriodEnd: boolean },
  ) => Promise<void>;
  /**
   * Charge a subscription's customer once, for something used rather than subscribed to (a month of
   * cloud running). The amount is whole cents of euro, before tax.
   *
   * Three outcomes, and the difference between them is the whole design. It RETURNS when the provider
   * took the charge. It THROWS {@link BillingUnavailableError} when the provider definitely did not
   * (refused, no such subscription, not set up), which is safe to try again later. It THROWS
   * {@link BillingChargeUncertain} when it cannot know, which is never tried again by a machine.
   */
  charge?: (
    providerSubscriptionId: string,
    request: { amountCents: number; description: string },
  ) => Promise<{ reference: string }>;
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
