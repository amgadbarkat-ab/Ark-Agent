import { eq } from "drizzle-orm";
import type { CloudRates } from "../../../shared/cloud-pricing";
import type { Database } from "../db/client";
import { cloudAccounts, cloudRates } from "../db/schema";

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

export type CloudAccount = {
  enabled: boolean;
  monthlyCapCents: number | null;
  consentedAt: Date | null;
  consentedRates: CloudRates | null;
};

export type CloudStore = {
  rates: () => Promise<CloudRates | null>;
  setRates: (rates: CloudRates, byUserId: string) => Promise<void>;
  account: (tenantId: string) => Promise<CloudAccount>;
  /** `shownRates` are the rates the person saw; they must still be the current ones. */
  enable: (
    tenantId: string,
    input: { monthlyCapCents: number; shownRates: CloudRates },
  ) => Promise<void>;
  setCap: (tenantId: string, monthlyCapCents: number) => Promise<void>;
  disable: (tenantId: string) => Promise<void>;
};

const same = (a: CloudRates, b: CloudRates) =>
  (Object.keys(a) as (keyof CloudRates)[]).every((key) => a[key] === b[key]) &&
  Object.keys(a).length === Object.keys(b).length;

const NOTHING: CloudAccount = {
  enabled: false,
  monthlyCapCents: null,
  consentedAt: null,
  consentedRates: null,
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

    async account(tenantId) {
      const [row] = await database
        .select()
        .from(cloudAccounts)
        .where(eq(cloudAccounts.tenantId, tenantId))
        .limit(1);
      if (!row) return NOTHING;
      return {
        enabled: row.enabled,
        monthlyCapCents: row.monthlyCapCents,
        consentedAt: row.consentedAt,
        consentedRates: row.consentedRates,
      };
    },

    async enable(tenantId, { monthlyCapCents, shownRates }) {
      const rates = await current();
      if (!rates) throw new CloudRatesNotSet();
      if (!same(rates, shownRates)) throw new CloudRatesChanged();
      const now = new Date();
      await database
        .insert(cloudAccounts)
        .values({
          tenantId,
          enabled: true,
          monthlyCapCents,
          consentedAt: now,
          consentedRates: rates,
        })
        .onConflictDoUpdate({
          target: cloudAccounts.tenantId,
          set: {
            enabled: true,
            monthlyCapCents,
            consentedAt: now,
            consentedRates: rates,
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
  };
}
