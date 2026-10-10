import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** Something only the administrator can do anything about. The server decides what is listed. */
export type OverviewAttention = {
  id: string;
  /** `action`: waiting on a decision. `watch`: not broken, but worth a look. */
  severity: "action" | "watch";
  title: string;
  detail: string;
  /** The screen that deals with it. Null where there is none. */
  to: string | null;
};

export type OverviewCheck = {
  id: string;
  title: string;
  /** `todo` has to be done before customers can rely on this; `info` is fine either way. */
  state: "ok" | "todo" | "info";
  detail: string;
};

/**
 * What the administrator sees first. Every figure is the server's own count; nothing here names a
 * person or an account.
 */
export type Overview = {
  generatedAt: string;
  attention: OverviewAttention[];
  customers: {
    accounts: number;
    paying: number;
    pastDue: number;
    canceled: number;
    suspended: number;
    newLast7Days: number;
    newLast30Days: number;
    people: number;
    newPeopleLast7Days: number;
    byPlan: {
      planId: string;
      name: string;
      priceEurCents: number;
      paying: number;
    }[];
  };
  revenue: { monthlyRecurringCents: number };
  now: { runs: number; accounts: number; queuedWork: number };
  cloud: {
    mode: "included" | "metered";
    period: string;
    priced: boolean;
    accountsUsing: number;
    hours: number;
    costCents: number;
    chargeCents: number;
  } | null;
  checks: OverviewCheck[];
};

export const overviewKeys = { all: ["admin-overview"] as const };

export function overviewQueryOptions() {
  return queryOptions({
    queryKey: overviewKeys.all,
    queryFn: async (): Promise<Overview> =>
      (
        await client("/api/admin/overview", {
          fallback: "Could not load the overview",
        })
      ).json(),
    // A page that is left open should not go stale: what needs a decision changes while it is open.
    refetchInterval: 60_000,
  });
}
