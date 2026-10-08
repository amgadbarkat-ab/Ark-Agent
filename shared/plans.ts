/**
 * What Ark sells, as data. Shared by the server (which enforces it) and the app (which shows it).
 *
 * Decisions D3 to D5 in docs/ark/01-product-decisions.md. Prices are per month, in euro cents, per
 * single user: there are no shared seats in v1. `seats` is here anyway, at 1, so that adding shared
 * seats later is a change to this table and not to every place that assumes one person.
 *
 * A "bot" in `maxActiveBots` is counted only while it is hired AND has a run in progress. Installing
 * one, an idle one, and one that is only waiting for its next scheduled run never count.
 */

export type PlanId = "agent" | "team" | "enterprise" | "internal";

export type Plan = {
  id: PlanId;
  name: string;
  /** Euro cents per month. Zero for a plan that is not sold. */
  priceEurCents: number;
  /** How many different bots may be working at the same moment. Null means no limit. */
  maxActiveBots: number | null;
  /** People under one account. Always 1 for now; see above. */
  seats: number;
  /** Whether a customer can choose it. The internal plan is for our own staff and never listed. */
  purchasable: boolean;
  /** One line for the plan picker. */
  summary: string;
};

export const PLANS: readonly Plan[] = [
  {
    id: "agent",
    name: "Ark Agent",
    priceEurCents: 5_000,
    maxActiveBots: 1,
    seats: 1,
    purchasable: true,
    summary: "One digital employee, working for you.",
  },
  {
    id: "team",
    name: "Ark Team",
    priceEurCents: 10_000,
    maxActiveBots: 15,
    seats: 1,
    purchasable: true,
    summary: "Up to 15 digital employees working at the same time.",
  },
  {
    id: "enterprise",
    name: "Ark Team Enterprise",
    priceEurCents: 25_000,
    maxActiveBots: 500,
    seats: 1,
    purchasable: true,
    summary: "Up to 500 digital employees working at the same time.",
  },
  {
    id: "internal",
    name: "Internal",
    priceEurCents: 0,
    maxActiveBots: null,
    seats: 1,
    purchasable: false,
    summary: "For our own staff. Not sold.",
  },
];

export function planById(id: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** The plans a customer can choose, cheapest first. */
export function purchasablePlans(): Plan[] {
  return PLANS.filter((plan) => plan.purchasable).sort(
    (a, b) => a.priceEurCents - b.priceEurCents,
  );
}

/** The next plan up that allows more bots at once, or undefined if this is the top. */
export function nextPlanUp(id: string): Plan | undefined {
  const current = planById(id);
  if (!current || current.maxActiveBots === null) return undefined;
  return purchasablePlans().find(
    (plan) => (plan.maxActiveBots ?? Infinity) > (current.maxActiveBots ?? 0),
  );
}

/** "€50" or "€49.50" for display. */
export function formatEur(cents: number): string {
  const euros = cents / 100;
  return `€${Number.isInteger(euros) ? euros : euros.toFixed(2)}`;
}

/** How a subscription stands, as far as running bots is concerned. */
export type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

/**
 * Whether bots may run on a subscription in this state.
 *
 * `past_due` still runs: a card that failed once is not a reason to stop somebody's work mid-task,
 * and the billing provider retries. The account page says it plainly.
 */
export function subscriptionAllowsRuns(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}
