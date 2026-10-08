/**
 * What running a coworker in Ark's cloud costs, and what is charged for it.
 *
 * Decision D5 in docs/ark/01-product-decisions.md: running on the person's own computer is included
 * and costs Ark nothing, and running in Ark's cloud is an optional add-on that is metered and priced
 * so that the charge covers 100% of Ark's cost for that usage, including the payment provider's fees
 * and tax handling. Any margin on top is a separate business decision, so it is a setting that starts
 * at zero rather than a number buried in a formula.
 *
 * Pure arithmetic, shared by the server (which charges) and the app (which shows the person what
 * they are about to agree to). Nothing here knows what a rate is worth: the rates are set by staff
 * from measured cost (docs/ark/17-cloud-runtime.md says how to measure it), and until they are set
 * nothing is charged.
 */

export type CloudRates = {
  /** Cents for one hour of one coworker's cloud capacity being in use. May be fractional. */
  computeCentsPerHour: number;
  /** Cents for one GiB of a coworker's persistent storage held for a month. */
  storageCentsPerGbMonth: number;
  /** Cents for one GiB leaving the cloud. */
  egressCentsPerGb: number;
  /** What the payment provider keeps of every charge, as a percentage of it. */
  paymentFeePercent: number;
  /** What the payment provider keeps of every charge, in cents, whatever its size. */
  paymentFeeFixedCents: number;
  /** Added to cost, as a percentage. Zero until the business decides otherwise. */
  marginPercent: number;
  /** A month whose charge would be smaller than this is carried into the next month instead. */
  minimumChargeCents: number;
};

/** What was used, in the units it is measured in. */
export type CloudUsage = {
  /** Seconds one coworker's cloud capacity was in use, summed over coworkers. */
  computeSeconds: number;
  /** Bytes of persistent storage held, times the seconds they were held. */
  storageByteSeconds: number;
  /** Bytes that left the cloud. */
  egressBytes: number;
};

export const NO_USAGE: CloudUsage = {
  computeSeconds: 0,
  storageByteSeconds: 0,
  egressBytes: 0,
};

const GIB = 1024 ** 3;
/** The month storage is priced by: 730 hours, which is how the cloud providers price a month. */
export const BILLING_MONTH_SECONDS = 730 * 3600;

export type CostBreakdown = {
  /** Hours of capacity, GiB-months of storage and GiB of egress, for the person to read. */
  computeHours: number;
  storageGbMonths: number;
  egressGb: number;
  /** Cents of cost for each, unrounded. */
  computeCents: number;
  storageCents: number;
  egressCents: number;
  /** The three added up, unrounded. This is what the usage costs Ark before fees and margin. */
  costCents: number;
};

export function costOf(usage: CloudUsage, rates: CloudRates): CostBreakdown {
  const computeHours = usage.computeSeconds / 3600;
  const storageGbMonths =
    usage.storageByteSeconds / GIB / BILLING_MONTH_SECONDS;
  const egressGb = usage.egressBytes / GIB;
  const computeCents = computeHours * rates.computeCentsPerHour;
  const storageCents = storageGbMonths * rates.storageCentsPerGbMonth;
  const egressCents = egressGb * rates.egressCentsPerGb;
  return {
    computeHours,
    storageGbMonths,
    egressGb,
    computeCents,
    storageCents,
    egressCents,
    costCents: computeCents + storageCents + egressCents,
  };
}

/**
 * What to charge, in whole cents, so that after the payment provider has taken its fee what is left
 * is at least what the usage cost (plus any margin).
 *
 * The fee is partly a percentage of the charge, so it cannot simply be added: charging cost + fee
 * leaves the percentage taken off the fee too, and falls short. Solving for the charge:
 *
 *     charge × (1 − fee%) − fixed = cost × (1 + margin%)
 *     charge = (cost × (1 + margin%) + fixed) / (1 − fee%)
 *
 * Rounded UP to the cent, never down, because the promise is that the charge covers the cost.
 * `carriedCostCents` is the unbilled cost of earlier months that fell under the minimum; it is added
 * to this month's cost before the fee is applied, so a customer pays one fee for them all and not one
 * each.
 *
 * Nothing used, nothing charged: the fixed fee is not charged for an empty month.
 */
export function chargeCents(
  usage: CloudUsage,
  rates: CloudRates,
  carriedCostCents = 0,
): number {
  const cost = costOf(usage, rates).costCents + carriedCostCents;
  if (cost <= 0) return 0;
  const feeShare = rates.paymentFeePercent / 100;
  const wanted =
    (cost * (1 + rates.marginPercent / 100) + rates.paymentFeeFixedCents) /
    (1 - feeShare);
  // A hair of tolerance, so that floating point noise on an exact multiple does not cost a cent.
  return Math.ceil(wanted - 1e-9);
}

/** Whether a month's charge is big enough to send, or goes into the next month. */
export function isBelowMinimum(cents: number, rates: CloudRates): boolean {
  return cents > 0 && cents < rates.minimumChargeCents;
}

/**
 * The most a rate may be, to catch a decimal point in the wrong place before it is charged to
 * somebody. A hour of cloud for a hundred euro is a typo, not a price.
 */
export const RATE_LIMITS = {
  computeCentsPerHour: 10_000,
  storageCentsPerGbMonth: 10_000,
  egressCentsPerGb: 10_000,
  paymentFeePercent: 50,
  paymentFeeFixedCents: 1_000,
  marginPercent: 1_000,
  minimumChargeCents: 100_000,
} as const;

export type RatesCheck =
  | { ok: true; rates: CloudRates }
  | { ok: false; error: string };

const LABELS: Record<keyof CloudRates, string> = {
  computeCentsPerHour: "The price of an hour of running",
  storageCentsPerGbMonth: "The price of a gigabyte of storage for a month",
  egressCentsPerGb: "The price of a gigabyte leaving the cloud",
  paymentFeePercent: "The payment fee percentage",
  paymentFeeFixedCents: "The fixed payment fee",
  marginPercent: "The margin",
  minimumChargeCents: "The minimum charge",
};

/** Rates as typed or sent, checked for sense. Never trusts the shape of its input. */
export function checkRates(input: unknown): RatesCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "The rates must be an object." };
  }
  const given = input as Record<string, unknown>;
  const rates = {} as CloudRates;
  for (const key of Object.keys(RATE_LIMITS) as (keyof CloudRates)[]) {
    const value = given[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return {
        ok: false,
        error: `${LABELS[key]} must be a number, zero or more.`,
      };
    }
    if (value > RATE_LIMITS[key]) {
      return {
        ok: false,
        error: `${LABELS[key]} is more than ${RATE_LIMITS[key]}, which looks like a mistake.`,
      };
    }
    rates[key] = value;
  }
  const unknown = Object.keys(given).filter((key) => !(key in RATE_LIMITS));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown rate: ${unknown[0]}.` };
  }
  if (rates.computeCentsPerHour <= 0) {
    return {
      ok: false,
      error: "The price of an hour of running must be more than zero.",
    };
  }
  return { ok: true, rates };
}

/** The usage of one month, as sentences a person can check against a bill. */
export function describeUsage(usage: CloudUsage, rates: CloudRates): string[] {
  const cost = costOf(usage, rates);
  const lines: string[] = [];
  lines.push(`${cost.computeHours.toFixed(2)} hours of running`);
  if (usage.storageByteSeconds > 0) {
    lines.push(`${cost.storageGbMonths.toFixed(3)} GB-months of storage`);
  }
  if (usage.egressBytes > 0) {
    lines.push(`${cost.egressGb.toFixed(3)} GB sent out`);
  }
  return lines;
}
