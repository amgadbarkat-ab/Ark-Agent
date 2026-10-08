import { queryOptions } from "@tanstack/react-query";
import type { CloudRates, CloudUsage } from "../../../../shared/cloud-pricing";
import { client } from "@/lib/client";

export type { CloudRates, CloudUsage };

/** The server's own word on how cloud running is offered on this deployment. */
export type CloudMode = "included" | "metered" | "off";

/**
 * Where an account stands with running in Ark's cloud.
 *
 * `addOn`, `priced`, `enabled`, `nearCap` and `atCap` are the server's verdicts, rendered as given.
 * The screen never works out from a charge and a limit whether something may run: a rule written
 * twice is a rule that differs.
 */
export type CloudStatus = {
  mode: CloudMode;
  /** A hosted service with customers, as against a company's own deployment. */
  hosted: boolean;
  /** Whether this account has to switch cloud running on, and pays for it. */
  addOn: boolean;
  /** Whether there are prices to agree to yet. */
  priced: boolean;
  rates: CloudRates | null;
  enabled: boolean;
  /** They agreed to prices that have since changed: nothing new runs in the cloud until they agree again. */
  ratesChanged: boolean;
  monthlyCapCents: number;
  defaultCapCents: number;
  /** The calendar month in UTC, "2026-10". */
  period: string;
  usage: CloudUsage;
  hours: number;
  usageLines: string[];
  /** What this month would cost if it ended now, in cents. */
  chargeSoFarCents: number;
  nearCap: boolean;
  atCap: boolean;
};

export type CloudChargeView = {
  id: string;
  period: string;
  /** "checking" is a month the payment service has not yet confirmed either way. */
  status: "checking" | "charged" | "carried" | "pending" | "waived";
  amountCents: number;
  usageLines: string[];
};

export type CloudOverview = {
  cloud: CloudStatus;
  charges: CloudChargeView[];
  limits: { minCents: number; maxCents: number };
};

export const cloudKeys = {
  all: ["cloud"] as const,
  mine: () => [...cloudKeys.all, "mine"] as const,
  admin: () => [...cloudKeys.all, "admin"] as const,
  rates: () => [...cloudKeys.admin(), "rates"] as const,
  usage: (period: string) =>
    [...cloudKeys.admin(), "usage", { period }] as const,
  charges: (status: string) =>
    [...cloudKeys.admin(), "charges", { status }] as const,
};

export function cloudQueryOptions() {
  return queryOptions({
    queryKey: cloudKeys.mine(),
    queryFn: async (): Promise<CloudOverview> =>
      (
        await client("/api/account/cloud", {
          fallback: "Could not load cloud running",
        })
      ).json(),
  });
}

/** Staff: the prices in force, and the largest each may be. */
export type AdminCloudRates = {
  mode: CloudMode;
  rates: CloudRates | null;
  limits: Record<keyof CloudRates, number>;
};

export function adminCloudRatesQueryOptions() {
  return queryOptions({
    queryKey: cloudKeys.rates(),
    queryFn: async (): Promise<AdminCloudRates> =>
      (
        await client("/api/admin/cloud/rates", {
          fallback: "Could not load the cloud prices",
        })
      ).json(),
  });
}

export type AdminCloudUsage = {
  period: string;
  priced: boolean;
  totals: { hours: number; costCents: number; chargeCents: number };
  accounts: {
    tenantId: string;
    name: string;
    enabled: boolean;
    hours: number;
    usageLines: string[];
    costCents: number;
    chargeCents: number;
  }[];
};

export function adminCloudUsageQueryOptions(period: string) {
  return queryOptions({
    queryKey: cloudKeys.usage(period),
    queryFn: async (): Promise<AdminCloudUsage> =>
      (
        await client(
          `/api/admin/cloud/usage${period ? `?period=${encodeURIComponent(period)}` : ""}`,
          { fallback: "Could not load cloud usage" },
        )
      ).json(),
  });
}

export type AdminCloudCharge = {
  id: string;
  tenantId: string;
  tenantName: string;
  period: string;
  status:
    | "charging"
    | "charged"
    | "carried"
    | "pending"
    | "uncertain"
    | "waived";
  costCents: number;
  amountCents: number;
  note: string | null;
  updatedAt: string;
};

export function adminCloudChargesQueryOptions(status = "") {
  return queryOptions({
    queryKey: cloudKeys.charges(status),
    queryFn: async (): Promise<AdminCloudCharge[]> =>
      client(
        `/api/admin/cloud/charges${status ? `?status=${encodeURIComponent(status)}` : ""}`,
        "charges",
        { fallback: "Could not load cloud charges" },
      ),
  });
}

/** "€0.60", "€0.006": a price per unit, which can be a fraction of a cent. */
export function formatRate(cents: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cents / 100);
}

/** "March 2026" for "2026-03". */
export function formatPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
