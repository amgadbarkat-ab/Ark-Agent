import {
  type ChargePart,
  type CloudRates,
  type CloudUsage,
  costOf,
  NO_USAGE,
  type PricedUsage,
} from "../../../shared/cloud-pricing";
import { periodBounds } from "./intervals";
import type { CloudMeter } from "./meter";
import type { CloudAccount } from "./store";

/**
 * What an account has used in a month that it is answerable for, priced at what it agreed to.
 *
 * An account is only ever charged for time after it agreed to the prices, at the prices it agreed to
 * for that stretch. If staff change the prices and the person agrees to the new ones, a month that
 * straddles the two is two parts, each at its own rates. Nothing here reads the prices staff have set
 * today: those are what a person is offered, not what they owe.
 */
export type Billable = {
  /** One for each agreement that overlaps the month and had any usage under it. */
  parts: (PricedUsage & {
    from: Date;
    until: Date | null;
    costCents: number;
  })[];
  /** The parts added together, for showing a person how much they used. */
  usage: CloudUsage;
  /** The cost of all of it to Ark, unrounded, in cents. */
  costCents: number;
  /** The newest agreement's prices: the ones the fee, and anything carried over, are worked out with. */
  closing: CloudRates | null;
};

export async function billableFor(
  meter: CloudMeter,
  tenantId: string,
  period: string,
  account: CloudAccount,
): Promise<Billable> {
  const { start, end } = periodBounds(period);
  const parts: Billable["parts"] = [];
  const total: CloudUsage = { ...NO_USAGE };
  let costCents = 0;
  for (const agreement of account.agreements) {
    if (agreement.from >= end) continue;
    if (agreement.until && agreement.until <= start) continue;
    const usage = await meter.usageFor(tenantId, period, {
      since: agreement.from,
      ...(agreement.until ? { until: agreement.until } : {}),
    });
    if (
      usage.computeSeconds <= 0 &&
      usage.storageByteSeconds <= 0 &&
      usage.egressBytes <= 0
    ) {
      continue;
    }
    const partCost = costOf(usage, agreement.rates).costCents;
    parts.push({
      usage,
      rates: agreement.rates,
      from: agreement.from,
      until: agreement.until,
      costCents: partCost,
    });
    total.computeSeconds += usage.computeSeconds;
    total.storageByteSeconds += usage.storageByteSeconds;
    total.egressBytes += usage.egressBytes;
    costCents += partCost;
  }
  return {
    parts,
    usage: total,
    costCents,
    closing: account.agreements.at(-1)?.rates ?? null,
  };
}

/** The parts as stored with a charge, so that it can always be explained. */
export function chargePartsOf(billable: Billable): ChargePart[] {
  return billable.parts.map((part) => ({
    from: part.from.toISOString(),
    until: part.until ? part.until.toISOString() : null,
    usage: part.usage,
    rates: part.rates,
    costCents: part.costCents,
  }));
}
