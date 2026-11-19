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
import { translateText } from "./i18n/translate";

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
    name: "ArkAgent",
    priceEurCents: 5_000,
    maxActiveBots: 1,
    seats: 1,
    purchasable: true,
    summary: "One digital employee, working for you.",
  },
  {
    id: "team",
    name: "Ark Team",
    // The tier it starts from (AGENT_TIERS below); the tier's own price is what is charged.
    priceEurCents: 10_000,
    maxActiveBots: 15,
    seats: 1,
    purchasable: true,
    summary:
      "5, 10 or 20 digital employees per person, from €100 per person a month.",
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

/**
 * Ark Team's tiers (v0.1.49; COO's live Stripe setup of 19 Nov, ordered by Amgad). Each is its own
 * Stripe product, per seat (one seat per person) a month, in euro, before tax, so a customer can
 * switch tiers in the billing portal. "Agents" are digital employees on the install.
 *
 * THE LIMIT IS PER INSTALL: agents per seat times seats, counted together. 3 seats on the 10 tier
 * may have 30 digital employees on that computer, made by anybody. `maxActiveBots` (how many work
 * at the same moment) is a separate limit and is unchanged.
 */
export type AgentsPerSeat = 5 | 10 | 20;

export type AgentTier = { agentsPerSeat: AgentsPerSeat; priceEurCents: number };

export const AGENT_TIERS: readonly AgentTier[] = [
  { agentsPerSeat: 5, priceEurCents: 10_000 },
  { agentsPerSeat: 10, priceEurCents: 14_000 },
  { agentsPerSeat: 20, priceEurCents: 20_000 },
];

/** What a team licence without a tier counts as: keys from before v0.1.49, and trials. */
export const DEFAULT_AGENTS_PER_SEAT: AgentsPerSeat = 5;

/** The plans whose digital employees are counted. ArkAgent and Enterprise are unchanged. */
const TIERED_PLANS: readonly string[] = ["team"];

export function isAgentsPerSeat(value: unknown): value is AgentsPerSeat {
  return AGENT_TIERS.some((tier) => tier.agentsPerSeat === value);
}

/** Whether this plan's digital employees are counted against a tier. */
export function planHasAgentTiers(planId: string): boolean {
  return TIERED_PLANS.includes(planId);
}

/**
 * How many digital employees an install may have, or null for no limit (every plan but Ark Team).
 * An install already above it keeps every one: it only cannot add more.
 */
export function agentLimitFor(licence: {
  planId: string;
  agentsPerSeat?: number | null;
  seats?: number | null;
}): number | null {
  if (!planHasAgentTiers(licence.planId)) return null;
  const perSeat = isAgentsPerSeat(licence.agentsPerSeat)
    ? licence.agentsPerSeat
    : DEFAULT_AGENTS_PER_SEAT;
  const seats =
    licence.seats && Number.isInteger(licence.seats) && licence.seats > 0
      ? licence.seats
      : 1;
  return perSeat * seats;
}

/** The tier above, or undefined at the top. */
export function nextAgentTier(agentsPerSeat: number): AgentTier | undefined {
  return AGENT_TIERS.find((tier) => tier.agentsPerSeat > agentsPerSeat);
}

/*
 * The sentence shown when an install has reached its limit: on the refusal and beside every "add"
 * button. Written once in English with placeholders; the Greek is in i18n/el/trial.ts.
 */
export const AGENT_LIMIT_NEXT_TIER =
  "Your Ark Team plan allows {limit} digital employees on this computer, and {inUse} are set up. To add more, move up to {next} digital employees per person ({price} per person a month) in the billing portal, or add a person to your subscription.";
export const AGENT_LIMIT_TOP_TIER =
  "Your Ark Team plan allows {limit} digital employees on this computer, and {inUse} are set up. To add more, add a person to your subscription in the billing portal: each person adds {perSeat}.";
export const AGENT_LIMIT_TRIAL =
  "Your trial allows {limit} digital employees on this computer, and {inUse} are set up. To have more, choose Ark Team with 10 or 20 digital employees per person when you buy.";

export type AgentLimitNotice = {
  en: string;
  el: string;
  /** The English template and its values, for a screen that translates for itself. */
  template: string;
  values: Record<string, string | number>;
};

export function agentLimitNotice(state: {
  limit: number;
  inUse: number;
  agentsPerSeat: number;
  trial: boolean;
}): AgentLimitNotice {
  const next = nextAgentTier(state.agentsPerSeat);
  const template = state.trial
    ? AGENT_LIMIT_TRIAL
    : next
      ? AGENT_LIMIT_NEXT_TIER
      : AGENT_LIMIT_TOP_TIER;
  const values: Record<string, string | number> = {
    limit: state.limit,
    inUse: state.inUse,
    perSeat: state.agentsPerSeat,
    ...(next
      ? { next: next.agentsPerSeat, price: formatEur(next.priceEurCents) }
      : {}),
  };
  return {
    en: translateText("en", template, values),
    el: translateText("el", template, values),
    template,
    values,
  };
}

/** "€50" or "€49.50" for display. */
export function formatEur(cents: number): string {
  const euros = cents / 100;
  return `€${Number.isInteger(euros) ? euros : euros.toFixed(2)}`;
}

/** How a subscription stands, as far as running bots is concerned. */
/**
 * How long the free trial is, in days (Amgad's company-wide rule, 12 Nov 2026; it was 30). On day
 * `FREE_TRIAL_DAYS + 1` an account still without a plan pauses read-only (docs/ark/01-product-decisions.md).
 * Customers offered a 30-day trial before 12 Nov 2026 keep 30 days.
 *
 * ArkAgent counts it itself: an account whose trial was started here (`ARK_FREE_TRIAL_ENABLED`, see
 * server/src/accounts/store.ts) ends `FREE_TRIAL_DAYS` days after it was made, and any `trialing`
 * subscription past its end stops running, whatever a payment provider has or has not said. The
 * Stripe price or Paddle price, set at go-live, must match this number (see the `trialing` notes in
 * server/src/billing/stripe.ts and paddle.ts).
 */
export const FREE_TRIAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a trial that starts at `start` ends: `FREE_TRIAL_DAYS` whole days later. */
export function trialEndFrom(start: Date): Date {
  return new Date(start.getTime() + FREE_TRIAL_DAYS * DAY_MS);
}

/**
 * Whole days left on a trial ending at `end`, counted up: 7 on the day it starts, 1 on its last
 * day, 0 once it has ended (day 8).
 */
export function trialDaysLeft(end: Date, now: Date = new Date()): number {
  const left = end.getTime() - now.getTime();
  return left <= 0 ? 0 : Math.ceil(left / DAY_MS);
}

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
