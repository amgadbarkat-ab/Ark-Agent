import { createHmac, timingSafeEqual } from "node:crypto";
import type { SubscriptionStatus } from "../../../shared/plans";
import {
  type BillingEvent,
  type BillingProvider,
  BillingSignatureError,
} from "./provider";

const HEADER = "x-ark-sandbox-signature";

/** Signs a body the way the sandbox provider verifies it. For tests and local demonstrations. */
export function signSandboxBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * A stand-in payment provider with real signature checking and no money.
 *
 * It exists so the whole path (choose a plan, be sent to pay, the notification arrives, the account
 * becomes active) can be run and tested end to end before a real provider is chosen, and so the
 * webhook code is exercised with the same hostile inputs a real one will see. It must never be
 * enabled on a deployment that takes real payments: it is selected only by name, and the secret is
 * required.
 */
export function sandboxBilling(options: {
  secret: string;
  /** Where the fake checkout page lives; the customer is sent here with the plan in the query. */
  checkoutBase: string;
}): BillingProvider {
  return {
    id: "sandbox",
    async createCheckout(request) {
      const url = new URL(options.checkoutBase);
      url.searchParams.set("tenant", request.tenantId);
      url.searchParams.set("plan", request.planId);
      return { url: url.toString() };
    },
    async createPortal(_customerId, returnUrl) {
      return { url: returnUrl };
    },
    async cancel() {},
    parseWebhook(headers, rawBody) {
      const offered = headers.get(HEADER) ?? "";
      const expected = signSandboxBody(options.secret, rawBody);
      const a = Buffer.from(offered);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new BillingSignatureError();
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new BillingSignatureError();
      }
      const list = Array.isArray(body) ? body : [body];
      return list.map((item): BillingEvent => {
        const e = item as Record<string, unknown>;
        return {
          eventId: String(e.eventId ?? ""),
          type: String(e.type ?? "unknown"),
          ...(typeof e.tenantId === "string" ? { tenantId: e.tenantId } : {}),
          ...(typeof e.customerId === "string"
            ? { providerCustomerId: e.customerId }
            : {}),
          ...(typeof e.subscriptionId === "string"
            ? { providerSubscriptionId: e.subscriptionId }
            : {}),
          ...(typeof e.planId === "string" ? { planId: e.planId } : {}),
          ...(typeof e.status === "string"
            ? { status: e.status as SubscriptionStatus }
            : {}),
          ...(typeof e.currentPeriodEnd === "string"
            ? { currentPeriodEnd: new Date(e.currentPeriodEnd) }
            : {}),
          ...(typeof e.cancelAtPeriodEnd === "boolean"
            ? { cancelAtPeriodEnd: e.cancelAtPeriodEnd }
            : {}),
        };
      });
    },
  };
}

export const SANDBOX_SIGNATURE_HEADER = HEADER;
