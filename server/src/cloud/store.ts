import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type AgreementSegment,
  type CloudRates,
  type CloudUsage,
  sameRates,
} from "../../../shared/cloud-pricing";
import type { Database } from "../db/client";
import { cloudAccounts, cloudCharges, cloudRates, tenants } from "../db/schema";

/**
 * What staff have priced, and what each account has agreed to.
 *
 * Switching cloud running on records the rates the person was looking at, and refuses if they are no
 * longer the current ones: an agreement to pay is an agreement to a number, and a number that moved
 * between the screen and the click is not one they agreed to.
 */

export class CloudRatesNotSet extends Error {
  constructor() {
    super("Cloud running has not been priced yet.");
    this.name = "CloudRatesNotSet";
  }
}

export class CloudRatesChanged extends Error {
  constructor() {
    super("The prices changed while you were looking. Read them again.");
    this.name = "CloudRatesChanged";
  }
}

/** One set of prices a person agreed to, and the stretch of time it applied. Open while it is current. */
export type Agreement = {
  from: Date;
  /** Null for the agreement in force now. */
  until: Date | null;
  rates: CloudRates;
};

export type CloudAccount = {
  enabled: boolean;
  monthlyCapCents: number | null;
  consentedAt: Date | null;
  consentedRates: CloudRates | null;
  /** Every agreement, oldest first, the last of them the one in force. Empty if they never agreed. */
  agreements: Agreement[];
};

/**
 * Whether the person agreed to prices that are no longer the prices. They stay agreed to for what was
 * already used, but nothing new runs in the cloud until they agree to the new ones.
 */
export function ratesChangedFor(
  account: CloudAccount,
  current: CloudRates | null,
): boolean {
  return (
    account.enabled &&
    current !== null &&
    account.consentedRates !== null &&
    !sameRates(account.consentedRates, current)
  );
}

export type CloudChargeStatus =
  | "charging"
  | "charged"
  | "carried"
  | "pending"
  | "uncertain"
  | "waived";

export type CloudChargeRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  period: string;
  status: CloudChargeStatus;
  usage: CloudUsage;
  /** What it cost Ark, unrounded, in cents. */
  costCents: number;
  /** What was or will be charged, in whole cents. */
  amountCents: number;
  note: string | null;
  updatedAt: Date;
};

export type CloudStore = {
  rates: () => Promise<CloudRates | null>;
  setRates: (rates: CloudRates, byUserId: string) => Promise<void>;
  account: (tenantId: string) => Promise<CloudAccount>;
  /** `shownRates` are the rates the person saw; they must still be the current ones. */
  enable: (
    tenantId: string,
    input: {
      monthlyCapCents: number;
      shownRates: CloudRates;
      /** When the agreement is made, if not now. For tests, which choose their own dates. */
      at?: Date;
    },
  ) => Promise<void>;
  setCap: (tenantId: string, monthlyCapCents: number) => Promise<void>;
  disable: (tenantId: string) => Promise<void>;
  /** Months charged (or waiting to be), newest first. One account's, or everyone's for staff. */
  charges: (filter: {
    tenantId?: string;
    statuses?: CloudChargeStatus[];
    limit: number;
  }) => Promise<CloudChargeRow[]>;
  /** What the accounts are called, for staff screens. */
  tenantNames: (tenantIds: string[]) => Promise<Map<string, string>>;
};

const NOTHING: CloudAccount = {
  enabled: false,
  monthlyCapCents: null,
  consentedAt: null,
  consentedRates: null,
  agreements: [],
};

export function createCloudStore(database: Database): CloudStore {
  async function current(): Promise<CloudRates | null> {
    const [row] = await database
      .select({ rates: cloudRates.rates })
      .from(cloudRates)
      .where(eq(cloudRates.id, "current"))
      .limit(1);
    return row?.rates ?? null;
  }

  async function account(tenantId: string): Promise<CloudAccount> {
    const [row] = await database
      .select()
      .from(cloudAccounts)
      .where(eq(cloudAccounts.tenantId, tenantId))
      .limit(1);
    if (!row) return NOTHING;
    const agreements: Agreement[] = row.agreementHistory.map((segment) => ({
      from: new Date(segment.from),
      until: new Date(segment.until),
      rates: segment.rates,
    }));
    if (row.consentedAt && row.consentedRates) {
      agreements.push({
        from: row.consentedAt,
        until: null,
        rates: row.consentedRates,
      });
    }
    return {
      enabled: row.enabled,
      monthlyCapCents: row.monthlyCapCents,
      consentedAt: row.consentedAt,
      consentedRates: row.consentedRates,
      agreements,
    };
  }

  return {
    rates: current,

    async setRates(rates, byUserId) {
      await database
        .insert(cloudRates)
        .values({ id: "current", rates, setBy: byUserId })
        .onConflictDoUpdate({
          target: cloudRates.id,
          set: { rates, setBy: byUserId, updatedAt: new Date() },
        });
    },

    account,

    async enable(tenantId, { monthlyCapCents, shownRates, at }) {
      const rates = await current();
      if (!rates) throw new CloudRatesNotSet();
      if (!sameRates(rates, shownRates)) throw new CloudRatesChanged();
      const now = at ?? new Date();
      const before = await account(tenantId);
      /*
       * Agreeing again to prices already agreed to is not a new agreement. Moving the date forward
       * would quietly drop whatever was used since the first one (a run still going when it was
       * switched off and on again) from what the person is charged, and from the limit they set.
       *
       * Agreeing to DIFFERENT prices is. The agreement being replaced is closed at this moment and
       * kept, so that what was used under it is still priced at what was agreed for it, and the new
       * one starts now.
       */
      const sameAgreement =
        before.consentedAt !== null &&
        before.consentedRates !== null &&
        sameRates(before.consentedRates, rates);
      const consentedAt = sameAgreement ? (before.consentedAt as Date) : now;
      const closed: AgreementSegment[] = before.agreements
        .filter((agreement) => agreement.until !== null)
        .map((agreement) => ({
          from: agreement.from.toISOString(),
          until: (agreement.until as Date).toISOString(),
          rates: agreement.rates,
        }));
      if (!sameAgreement && before.consentedAt && before.consentedRates) {
        closed.push({
          from: before.consentedAt.toISOString(),
          until: now.toISOString(),
          rates: before.consentedRates,
        });
      }
      await database
        .insert(cloudAccounts)
        .values({
          tenantId,
          enabled: true,
          monthlyCapCents,
          consentedAt,
          consentedRates: rates,
          agreementHistory: closed,
        })
        .onConflictDoUpdate({
          target: cloudAccounts.tenantId,
          set: {
            enabled: true,
            monthlyCapCents,
            consentedAt,
            consentedRates: rates,
            agreementHistory: closed,
            updatedAt: now,
          },
        });
    },

    async setCap(tenantId, monthlyCapCents) {
      await database
        .update(cloudAccounts)
        .set({ monthlyCapCents, updatedAt: new Date() })
        .where(eq(cloudAccounts.tenantId, tenantId));
    },

    async disable(tenantId) {
      await database
        .update(cloudAccounts)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(cloudAccounts.tenantId, tenantId));
    },

    async charges({ tenantId, statuses, limit }) {
      const rows = await database
        .select({
          id: cloudCharges.id,
          tenantId: cloudCharges.tenantId,
          tenantName: tenants.name,
          period: cloudCharges.period,
          status: cloudCharges.status,
          usage: cloudCharges.usage,
          costCents: cloudCharges.costCents,
          amountCents: cloudCharges.amountCents,
          note: cloudCharges.note,
          updatedAt: cloudCharges.updatedAt,
        })
        .from(cloudCharges)
        .innerJoin(tenants, eq(tenants.id, cloudCharges.tenantId))
        .where(
          and(
            ...(tenantId ? [eq(cloudCharges.tenantId, tenantId)] : []),
            ...(statuses?.length
              ? [inArray(cloudCharges.status, statuses)]
              : []),
          ),
        )
        .orderBy(desc(cloudCharges.period), desc(cloudCharges.updatedAt))
        .limit(limit);
      return rows.map((row) => ({ ...row, costCents: Number(row.costCents) }));
    },

    async tenantNames(tenantIds) {
      if (tenantIds.length === 0) return new Map();
      const rows = await database
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .where(inArray(tenants.id, tenantIds));
      return new Map(rows.map((row) => [row.id, row.name]));
    },
  };
}
