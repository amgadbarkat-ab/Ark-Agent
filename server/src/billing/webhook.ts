import { and, eq } from "drizzle-orm";
import { planById, type SubscriptionStatus } from "../../../shared/plans";
import { type AccountStore, UnknownAccountError } from "../accounts/store";
import type { Database } from "../db/client";
import { billingEvents } from "../db/schema";
import {
  type BillingEvent,
  type BillingProvider,
  BillingSignatureError,
} from "./provider";

const STATUSES: readonly SubscriptionStatus[] = [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
];

export type WebhookOutcome =
  | { ok: true; applied: number; ignored: number; duplicates: number }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Turns a payment provider's notifications into changes to what an account has bought.
 *
 * Three promises, each because a payment provider will break it if we let it:
 * - Nothing unsigned is believed. The provider adapter verifies the signature over the raw body, and
 *   a bad one is a 400 that changes nothing.
 * - A repeated delivery does nothing. Providers retry, and out of order. The provider's event id is
 *   recorded first, and a second arrival of it is counted as a duplicate.
 * - A notification we cannot act on (no such account, a plan we do not sell, a status that does not
 *   exist) is recorded and ignored, not retried forever: answering with an error would only make the
 *   provider send the same thing again.
 */
export function createBillingWebhook(options: {
  database: Database;
  accounts: AccountStore;
  providers: ReadonlyMap<string, BillingProvider>;
  /** Told after each change that took effect, for the audit trail. */
  onApplied?: (change: {
    tenantId: string;
    provider: string;
    event: BillingEvent;
  }) => Promise<void>;
}) {
  const { database, accounts, providers } = options;

  async function tenantFor(provider: string, event: BillingEvent) {
    if (event.tenantId) return event.tenantId;
    if (event.providerCustomerId) {
      return accounts.tenantIdForProviderCustomer(
        provider,
        event.providerCustomerId,
      );
    }
    return undefined;
  }

  return {
    async handle(
      providerId: string,
      headers: Headers,
      rawBody: string,
    ): Promise<WebhookOutcome> {
      const provider = providers.get(providerId);
      if (!provider) {
        return { ok: false, status: 404, error: "No such billing provider." };
      }
      let events: BillingEvent[];
      try {
        events = await provider.parseWebhook(headers, rawBody);
      } catch (error) {
        if (error instanceof BillingSignatureError) {
          return { ok: false, status: 400, error: error.message };
        }
        throw error;
      }

      let applied = 0;
      let ignored = 0;
      let duplicates = 0;
      for (const event of events) {
        if (!event.eventId) {
          ignored += 1;
          continue;
        }
        const [first] = await database
          .insert(billingEvents)
          .values({
            provider: providerId,
            eventId: event.eventId,
            type: event.type,
            tenantId: null,
            payload: JSON.parse(JSON.stringify(event)),
          })
          .onConflictDoNothing()
          .returning({ id: billingEvents.id });
        if (!first) {
          duplicates += 1;
          continue;
        }

        const tenantId = await tenantFor(providerId, event);
        const knownPlan =
          event.planId === undefined || !!planById(event.planId);
        const knownStatus =
          event.status === undefined || STATUSES.includes(event.status);
        if (!tenantId || !knownPlan || !knownStatus) {
          ignored += 1;
          continue;
        }

        try {
          await accounts.applySubscription(tenantId, {
            provider: providerId,
            ...(event.planId !== undefined ? { planId: event.planId } : {}),
            ...(event.status !== undefined ? { status: event.status } : {}),
            ...(event.providerCustomerId !== undefined
              ? { providerCustomerId: event.providerCustomerId }
              : {}),
            ...(event.providerSubscriptionId !== undefined
              ? { providerSubscriptionId: event.providerSubscriptionId }
              : {}),
            ...(event.currentPeriodEnd !== undefined
              ? { currentPeriodEnd: event.currentPeriodEnd }
              : {}),
            ...(event.cancelAtPeriodEnd !== undefined
              ? { cancelAtPeriodEnd: event.cancelAtPeriodEnd }
              : {}),
          });
        } catch (error) {
          // An account that does not exist will not exist on the retry either.
          if (error instanceof UnknownAccountError) {
            ignored += 1;
            continue;
          }
          // Not applied, so not recorded as seen: the provider's retry gets another go.
          await database
            .delete(billingEvents)
            .where(
              and(
                eq(billingEvents.provider, providerId),
                eq(billingEvents.eventId, event.eventId),
              ),
            );
          throw error;
        }
        await database
          .update(billingEvents)
          .set({ tenantId })
          .where(eq(billingEvents.id, first.id));
        applied += 1;
        await options.onApplied?.({ tenantId, provider: providerId, event });
      }
      return { ok: true, applied, ignored, duplicates };
    },
  };
}

export type BillingWebhook = ReturnType<typeof createBillingWebhook>;
