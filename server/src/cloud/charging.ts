import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  chargeForParts,
  type CloudRates,
  isBelowMinimum,
} from "../../../shared/cloud-pricing";
import type { AccountStore } from "../accounts/store";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import {
  BillingChargeUncertain,
  type BillingProvider,
} from "../billing/provider";
import type { Database } from "../db/client";
import { cloudCharges } from "../db/schema";
import { billableFor, chargePartsOf } from "./billable";
import { periodBounds, periodOf } from "./intervals";
import type { CloudMeter } from "./meter";
import type { CloudStore } from "./store";

/**
 * Charging a closed month of cloud running, once.
 *
 * The month is worked out from the record of time used and the rates in force at that moment, written
 * down (so what was charged can always be explained), and only then sent to the payment provider. A
 * charge has exactly one row per account and month, and the row is written BEFORE the provider is
 * asked, which is what makes this safe to run again after a crash, a deploy or a second schedule:
 *
 * - no row: this month has not been tried, and is;
 * - `charged`, `carried`, `waived`: done, never touched again;
 * - `pending`: the provider definitely said no (a refused card), so it is tried again next run;
 * - `charging` or `uncertain`: it was sent and the answer is unknown, so it is NEVER sent again by a
 *   machine. A person looks at the payment provider's own record and settles it (`settle`).
 *
 * The one failure this design exists to prevent is taking somebody's money twice.
 */

export type ChargingDeps = {
  database: Database;
  meter: CloudMeter;
  store: CloudStore;
  billing: BillingProvider;
  accounts: Pick<AccountStore, "providerSubscriptionIdFor">;
  audit?: AuditStore;
  now?: () => Date;
};

export type ChargingReport = {
  period: string;
  charged: number;
  carried: number;
  pending: number;
  uncertain: number;
  skipped: number;
  /** Total of what was charged, in cents. */
  chargedCents: number;
};

const label = (period: string) => {
  const { start } = periodBounds(period);
  return `Ark cloud running, ${start.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}`;
};

/** The unbilled cost of earlier months that were too small to charge, which rides with this one. */
async function carriedBefore(
  database: Database,
  tenantId: string,
  period: string,
) {
  const rows = await database
    .select({ id: cloudCharges.id, costCents: cloudCharges.costCents })
    .from(cloudCharges)
    .where(
      and(
        eq(cloudCharges.tenantId, tenantId),
        eq(cloudCharges.status, "carried"),
        lt(cloudCharges.period, period),
      ),
    );
  return {
    ids: rows.map((row) => row.id),
    costCents: rows.reduce((total, row) => total + Number(row.costCents), 0),
  };
}

export async function chargePeriod(
  deps: ChargingDeps,
  period: string,
  tenantFilter?: string,
): Promise<ChargingReport> {
  const { database, meter, store, billing, accounts } = deps;
  const report: ChargingReport = {
    period,
    charged: 0,
    carried: 0,
    pending: 0,
    uncertain: 0,
    skipped: 0,
    chargedCents: 0,
  };
  if (period >= periodOf((deps.now ?? (() => new Date()))())) {
    throw new Error("Only a month that has ended can be charged.");
  }
  const rates = await store.rates();
  if (!rates) return report;

  const used = new Set(await meter.tenantsWithUsage(period));
  // Accounts that have only a small amount waiting from before are looked at too.
  const waiting = await database
    .selectDistinct({ tenantId: cloudCharges.tenantId })
    .from(cloudCharges)
    .where(eq(cloudCharges.status, "carried"));
  for (const row of waiting) used.add(row.tenantId);
  const tenants = tenantFilter
    ? [...used].filter((id) => id === tenantFilter)
    : [...used];

  for (const tenantId of tenants) {
    const [existing] = await database
      .select({ id: cloudCharges.id, status: cloudCharges.status })
      .from(cloudCharges)
      .where(
        and(
          eq(cloudCharges.tenantId, tenantId),
          eq(cloudCharges.period, period),
        ),
      )
      .limit(1);
    if (existing && existing.status !== "pending") {
      report.skipped += 1;
      continue;
    }

    const account = await store.account(tenantId);
    // Only accounts that agreed to a price, and only for what happened after they agreed, at the
    // prices they agreed to for that time. What staff have set since is what a person is offered,
    // not what they owe.
    if (account.agreements.length === 0) {
      report.skipped += 1;
      continue;
    }
    const billable = await billableFor(meter, tenantId, period, account);
    const carried = await carriedBefore(database, tenantId, period);
    const cost = billable.costCents;
    if (cost + carried.costCents <= 0) {
      report.skipped += 1;
      continue;
    }
    const closing = billable.closing as CloudRates;
    const amountCents = chargeForParts(
      billable.parts,
      carried.costCents,
      closing,
    );
    const usage = billable.usage;
    const parts = chargePartsOf(billable);

    if (isBelowMinimum(amountCents, closing) && !existing) {
      await database
        .insert(cloudCharges)
        .values({
          tenantId,
          period,
          status: "carried",
          usage,
          rates: closing,
          parts,
          costCents: String(cost),
          amountCents: 0,
          note: "Under the minimum, so it is added to the next month that is charged.",
        })
        .onConflictDoNothing();
      report.carried += 1;
      continue;
    }

    // Written down before anybody is asked. A second process that gets here too finds the row.
    let rowId = existing?.id;
    if (!rowId) {
      const [inserted] = await database
        .insert(cloudCharges)
        .values({
          tenantId,
          period,
          status: "charging",
          usage,
          rates: closing,
          parts,
          costCents: String(cost + carried.costCents),
          amountCents,
        })
        .onConflictDoNothing()
        .returning({ id: cloudCharges.id });
      if (!inserted) {
        report.skipped += 1;
        continue;
      }
      rowId = inserted.id;
    } else {
      // A month that was refused is being tried again: take it back to `charging` first, and only
      // if nobody else has, so that two schedules cannot both send it.
      const [taken] = await database
        .update(cloudCharges)
        .set({ status: "charging", amountCents, updatedAt: new Date() })
        .where(
          and(eq(cloudCharges.id, rowId), eq(cloudCharges.status, "pending")),
        )
        .returning({ id: cloudCharges.id });
      if (!taken) {
        report.skipped += 1;
        continue;
      }
    }

    const subscriptionId = await accounts.providerSubscriptionIdFor(
      tenantId,
      billing.id,
    );
    const settle = async (
      status: "charged" | "pending" | "uncertain",
      note: string | null,
      providerRef: string | null = null,
    ) => {
      await database
        .update(cloudCharges)
        .set({ status, note, providerRef, updatedAt: new Date() })
        .where(eq(cloudCharges.id, rowId as string));
    };

    if (!subscriptionId || !billing.charge) {
      await settle(
        "pending",
        "There is no subscription at the payment service to charge it to.",
      );
      report.pending += 1;
      continue;
    }

    try {
      const result = await billing.charge(subscriptionId, {
        amountCents,
        description: label(period),
      });
      await settle("charged", null, result.reference);
      if (carried.ids.length > 0) {
        await database
          .update(cloudCharges)
          .set({
            status: "charged",
            note: `Collected with ${period}.`,
            updatedAt: new Date(),
          })
          .where(inArray(cloudCharges.id, carried.ids));
      }
      report.charged += 1;
      report.chargedCents += amountCents;
      await audit(deps, "cloud.charged", tenantId, { period, amountCents });
    } catch (error) {
      if (error instanceof BillingChargeUncertain) {
        await settle(
          "uncertain",
          "The payment service did not say whether it took the charge. Look at its record, then settle this by hand.",
        );
        report.uncertain += 1;
        await audit(deps, "cloud.charge_failed", tenantId, {
          period,
          amountCents,
          outcome: "uncertain",
        });
      } else {
        await settle(
          "pending",
          "The payment service refused the charge. It is tried again at the next run.",
        );
        report.pending += 1;
        await audit(deps, "cloud.charge_failed", tenantId, {
          period,
          amountCents,
          outcome: "refused",
        });
      }
    }
  }
  return report;
}

async function audit(
  deps: ChargingDeps,
  eventType: "cloud.charged" | "cloud.charge_failed",
  tenantId: string,
  payload: Record<string, unknown>,
) {
  if (!deps.audit) return;
  await recordAuditEvent(deps.audit, {
    eventType,
    targetType: "tenant",
    targetId: tenantId,
    initiator: { kind: "deployment" },
    payload,
  }).catch(() => undefined);
}

/**
 * A person settles a month the machine could not: it was charged at the payment service after all
 * (`charged`), or it will not be charged (`waived`). Never for a month that is already final.
 */
export async function settleCharge(
  database: Database,
  chargeId: string,
  outcome: "charged" | "waived",
  note: string,
): Promise<boolean> {
  const done = await database
    .update(cloudCharges)
    .set({ status: outcome, note, updatedAt: new Date() })
    .where(
      and(
        eq(cloudCharges.id, chargeId),
        sql`${cloudCharges.status} in ('pending', 'charging', 'uncertain')`,
      ),
    )
    .returning({ id: cloudCharges.id });
  return done.length > 0;
}

export type { CloudRates };
