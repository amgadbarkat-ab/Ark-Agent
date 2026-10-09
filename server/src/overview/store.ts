import { and, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  cloudCharges,
  marketplaceListings,
  marketplaceReports,
  runSlots,
  subscriptions,
  tenants,
  users,
  workItems,
} from "../db/schema";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

/**
 * The numbers behind the administrator's overview: counts and nothing else.
 *
 * Every figure is a count or a sum over a handful of tables, taken with one small query each and
 * none of them reading a person's content. The overview is for deciding what to look at next, so
 * the names of accounts and people never appear in it; the screens it links to show those.
 */

export type PlanCount = {
  planId: string;
  status: string;
  count: number;
};

export type OverviewCounts = {
  accounts: {
    total: number;
    suspended: number;
    newLast7Days: number;
    newLast30Days: number;
  };
  /** Subscriptions grouped by plan and status, for the revenue and customer lines to be worked out from. */
  subscriptions: PlanCount[];
  people: { total: number; newLast7Days: number };
  running: { runs: number; accounts: number };
  work: { waiting: number; gaveUp: number };
  marketplace: { pendingListings: number; openReports: number };
  /**
   * Cloud charges a person has to decide (`uncertain`), or that have sat in `charging` for over an
   * hour (`stuck`): the answer was lost between asking the payment service and writing it down.
   */
  charges: { uncertain: number; stuck: number };
};

export type OverviewStore = {
  counts: () => Promise<OverviewCounts>;
};

const asNumber = (value: unknown) => Number(value ?? 0);

export function createOverviewStore(database: Database): OverviewStore {
  return {
    async counts() {
      const [
        accountRows,
        subscriptionRows,
        peopleRows,
        runningRows,
        workRows,
        listingRows,
        reportRows,
        chargeRows,
      ] = await Promise.all([
        database
          .select({
            total: count(),
            suspended: sql<number>`count(*) filter (where ${tenants.status} = 'suspended')`,
            newLast7Days: sql<number>`count(*) filter (where ${tenants.createdAt} > now() - interval '7 days')`,
            newLast30Days: sql<number>`count(*) filter (where ${tenants.createdAt} > now() - interval '30 days')`,
          })
          .from(tenants),
        database
          .select({
            planId: subscriptions.planId,
            status: subscriptions.status,
            count: count(),
          })
          .from(subscriptions)
          .groupBy(subscriptions.planId, subscriptions.status),
        database
          .select({
            total: count(),
            newLast7Days: sql<number>`count(*) filter (where ${users.createdAt} > now() - interval '7 days')`,
          })
          .from(users),
        database
          .select({
            runs: count(),
            accounts: sql<number>`count(distinct ${runSlots.tenantId})`,
          })
          .from(runSlots)
          .where(sql`${runSlots.expiresAt} > now()`),
        database
          .select({
            waiting: sql<number>`count(*) filter (where ${workItems.attempts} < ${DEFAULT_MAX_ATTEMPTS})`,
            gaveUp: sql<number>`count(*) filter (where ${workItems.attempts} >= ${DEFAULT_MAX_ATTEMPTS} and ${workItems.lastError} is not null)`,
          })
          .from(workItems)
          .where(
            and(
              isNull(workItems.finishedAt),
              or(
                isNull(workItems.leaseUntil),
                lt(workItems.leaseUntil, sql`now()`),
              ),
            ),
          ),
        database
          .select({ n: count() })
          .from(marketplaceListings)
          .where(eq(marketplaceListings.status, "pending")),
        database
          .select({ n: count() })
          .from(marketplaceReports)
          .where(eq(marketplaceReports.status, "open")),
        database
          .select({
            uncertain: sql<number>`count(*) filter (where ${cloudCharges.status} = 'uncertain')`,
            stuck: sql<number>`count(*) filter (where ${cloudCharges.status} = 'charging' and ${cloudCharges.updatedAt} < now() - interval '1 hour')`,
          })
          .from(cloudCharges),
      ]);

      const account = accountRows[0];
      const person = peopleRows[0];
      const running = runningRows[0];
      const work = workRows[0];
      const charge = chargeRows[0];
      return {
        accounts: {
          total: asNumber(account?.total),
          suspended: asNumber(account?.suspended),
          newLast7Days: asNumber(account?.newLast7Days),
          newLast30Days: asNumber(account?.newLast30Days),
        },
        subscriptions: subscriptionRows.map((row) => ({
          planId: row.planId,
          status: row.status,
          count: asNumber(row.count),
        })),
        people: {
          total: asNumber(person?.total),
          newLast7Days: asNumber(person?.newLast7Days),
        },
        running: {
          runs: asNumber(running?.runs),
          accounts: asNumber(running?.accounts),
        },
        work: {
          waiting: asNumber(work?.waiting),
          gaveUp: asNumber(work?.gaveUp),
        },
        marketplace: {
          pendingListings: asNumber(listingRows[0]?.n),
          openReports: asNumber(reportRows[0]?.n),
        },
        charges: {
          uncertain: asNumber(charge?.uncertain),
          stuck: asNumber(charge?.stuck),
        },
      };
    },
  };
}
