import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** A plan on offer, as the server's catalogue describes it. Prices are euro cents a month. */
export type PlanOffer = {
  id: string;
  name: string;
  priceEurCents: number;
  /** How many different coworkers may work at once. Null means no limit. */
  maxActiveBots: number | null;
  summary: string;
};

export type BlockedCode = "suspended" | "no_plan" | "canceled";

export type SubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

/**
 * What the signed-in person's account is, what it allows right now, and how much of it is in use.
 *
 * `canRun` and `blockedReason` are the server's verdict, rendered as it gave them. The screen never
 * works out from the status whether coworkers may run: a rule written twice is a rule that differs.
 */
export type AccountSummary = {
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  subscriptionStatus: SubscriptionStatus;
  maxActiveBots: number | null;
  canRun: boolean;
  blockedCode?: BlockedCode;
  blockedReason?: string;
  /** How many different coworkers are working right now. */
  activeBots: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

export type AccountOverview = {
  account: AccountSummary;
  billing: {
    /** "internal" means nobody pays and there are no plans to choose. */
    mode: "internal" | "subscriptions";
    provider: string;
    /** Whether the person can buy a plan themselves, or has to ask us. */
    selfService: boolean;
  };
  plans: PlanOffer[];
};

export const accountKeys = {
  all: ["account"] as const,
  overview: () => [...accountKeys.all, "overview"] as const,
  admin: (search = "") => [...accountKeys.all, "admin", { search }] as const,
};

export function accountQueryOptions() {
  return queryOptions({
    queryKey: accountKeys.overview(),
    queryFn: async (): Promise<AccountOverview> =>
      (
        await client("/api/account", {
          fallback: "Could not load your plan",
        })
      ).json(),
  });
}

/** One account as our staff see it. */
export type AdminAccount = {
  tenantId: string;
  name: string;
  ownerEmail: string | null;
  planId: string;
  subscriptionStatus: SubscriptionStatus;
  suspended: boolean;
  suspendedReason: string | null;
  activeBots: number;
  createdAt: string;
};

export type AdminAccountsPage = {
  tenants: AdminAccount[];
  nextCursor: string | null;
};

export function adminAccountsQueryOptions(search = "") {
  return infiniteQueryOptions({
    queryKey: accountKeys.admin(search),
    initialPageParam: "",
    queryFn: ({ pageParam }): Promise<AdminAccountsPage> => {
      const query = new URLSearchParams();
      if (search) query.set("search", search);
      if (pageParam) query.set("cursor", pageParam as string);
      const suffix = query.size > 0 ? `?${query}` : "";
      return client(`/api/admin/accounts${suffix}`, {
        fallback: "Could not load accounts",
      }).then((response) => response.json() as Promise<AdminAccountsPage>);
    },
    getNextPageParam: (page: AdminAccountsPage) => page.nextCursor ?? undefined,
  });
}

/** "€50" or "€49.50", the way people write prices. */
export function formatEur(cents: number): string {
  const euros = cents / 100;
  return `€${Number.isInteger(euros) ? euros : euros.toFixed(2)}`;
}
