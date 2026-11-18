/**
 * Stripe, read-only (Amgad, 18 Nov 2026, #149): paid customers, their subscription state, renewals
 * and failed payments. Plain `fetch` against Stripe's REST API with a RESTRICTED key that can only
 * read: Subscriptions (read), Checkout Sessions (read), Invoices (read). Nothing else; it never
 * writes. COO makes the key; it goes into the board's .env at a hidden prompt, never into the repo.
 *
 * WHICH CUSTOMER. A Stripe subscription does not carry ArkAgent's customer id: the buy page puts it
 * on the Checkout Session as `client_reference_id`. So the session list maps each subscription to
 * its customer id; a subscription with no such session shows as `stripe-<Stripe customer>`, the
 * same fallback the check-in service uses.
 *
 * Nothing about a person is read: no name, email or address, and no card. Answers are kept in
 * memory for a minute by the board, like every source.
 */
import type { Health } from "./sources";

export type StripeSubscription = {
  id: string;
  customerId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  /** When it renews, or ends if cancelAtPeriodEnd. */
  currentPeriodEnd: string | null;
  amountCents: number;
  currency: string;
  interval: string | null;
};

export type FailedPayment = {
  invoiceId: string;
  customerId: string;
  amountDueCents: number;
  currency: string;
  attempts: number;
  nextAttempt: string | null;
  at: string;
};

export type BillingSnapshot = {
  subscriptions: StripeSubscription[];
  failed: FailedPayment[];
};

export interface BillingSource {
  /** Null: not connected (no restricted read key yet). */
  snapshot(): Promise<BillingSnapshot | null>;
  health(): Promise<Health>;
}

/** Stripe before a restricted read-only key is given: not connected, and nothing is sent. */
export const stripeNotConnected: BillingSource = {
  async snapshot() {
    return null;
  },
  async health() {
    return { up: null, detail: "not connected" };
  },
};

type Page<T> = { data?: T[]; has_more?: boolean };

type RawSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: {
    data?: Array<{
      quantity?: number;
      current_period_end?: number;
      price?: {
        unit_amount?: number | null;
        currency?: string;
        recurring?: { interval?: string } | null;
      };
    }>;
  };
};

type RawSession = {
  subscription?: string | null;
  client_reference_id?: string | null;
};

type RawInvoice = {
  id: string;
  customer: string;
  subscription?: string | null;
  parent?: {
    subscription_details?: { subscription?: string | null } | null;
  } | null;
  amount_due?: number;
  currency?: string;
  attempt_count?: number;
  attempted?: boolean;
  next_payment_attempt?: number | null;
  created?: number;
};

const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
const MAX_PAGES = 10;

function iso(seconds: number | null | undefined): string | null {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : null;
}

export function stripeReadOnly(options: {
  apiKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
  now?: () => number;
}): BillingSource {
  const send = options.fetch ?? fetch;
  const base = options.apiBase ?? "https://api.stripe.com";
  const now = options.now ?? Date.now;

  async function list<T extends { id?: string }>(
    path: string,
    params: Record<string, string>,
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        ...params,
        limit: "100",
        ...(after ? { starting_after: after } : {}),
      });
      const response = await send(`${base}${path}?${query}`, {
        headers: { authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`Stripe answered ${response.status} for ${path}.`);
      const body = (await response.json()) as Page<T>;
      const data = body.data ?? [];
      out.push(...data);
      const last = data.at(-1)?.id;
      if (!body.has_more || !last) break;
      after = last;
    }
    return out;
  }

  return {
    async snapshot() {
      const [subscriptions, sessions, invoices] = await Promise.all([
        list<RawSubscription>("/v1/subscriptions", { status: "all" }),
        list<RawSession & { id?: string }>("/v1/checkout/sessions", {
          status: "complete",
        }),
        list<RawInvoice>("/v1/invoices", { status: "open" }),
      ]);
      const ours = new Map<string, string>();
      for (const session of sessions) {
        if (
          session.subscription &&
          session.client_reference_id &&
          CUSTOMER_ID.test(session.client_reference_id)
        ) {
          ours.set(session.subscription, session.client_reference_id);
        }
      }
      const customerOf = (
        subscription: string | null | undefined,
        stripeCustomer: string,
      ) =>
        (subscription ? ours.get(subscription) : undefined) ??
        `stripe-${stripeCustomer}`;
      return {
        subscriptions: subscriptions.map((sub) => {
          const items = sub.items?.data ?? [];
          return {
            id: sub.id,
            customerId: customerOf(sub.id, sub.customer),
            status: sub.status,
            cancelAtPeriodEnd: sub.cancel_at_period_end === true,
            // Newer API versions keep the period on each item; older ones on the subscription.
            currentPeriodEnd: iso(
              sub.current_period_end ?? items[0]?.current_period_end,
            ),
            amountCents: items.reduce(
              (sum, item) =>
                sum + (item.price?.unit_amount ?? 0) * (item.quantity ?? 1),
              0,
            ),
            currency: (items[0]?.price?.currency ?? "eur").toUpperCase(),
            interval: items[0]?.price?.recurring?.interval ?? null,
          };
        }),
        failed: invoices
          .filter(
            (invoice) =>
              (invoice.attempt_count ?? 0) > 0 || invoice.attempted === true,
          )
          .map((invoice) => ({
            invoiceId: invoice.id,
            customerId: customerOf(
              invoice.subscription ??
                invoice.parent?.subscription_details?.subscription,
              invoice.customer,
            ),
            amountDueCents: invoice.amount_due ?? 0,
            currency: (invoice.currency ?? "eur").toUpperCase(),
            attempts: invoice.attempt_count ?? 0,
            nextAttempt: iso(invoice.next_payment_attempt),
            at: iso(invoice.created) ?? new Date(now()).toISOString(),
          })),
      };
    },
    async health() {
      const started = now();
      try {
        const response = await send(`${base}/v1/subscriptions?limit=1`, {
          headers: { authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok
          ? { up: true, detail: "ok", ms: now() - started }
          : { up: false, detail: `HTTP ${response.status}` };
      } catch (error) {
        return {
          up: false,
          detail: error instanceof Error ? error.name : "unreachable",
        };
      }
    },
  };
}
