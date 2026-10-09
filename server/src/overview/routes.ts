import { Hono, type MiddlewareHandler } from "hono";
import { PLANS } from "../../../shared/plans";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { periodOf } from "../cloud/intervals";
import { monthlyUsage } from "../cloud/routes";
import type { CloudMeter } from "../cloud/meter";
import type { CloudStore } from "../cloud/store";
import { type Check, type DeploymentFacts, goLiveChecks } from "./checks";
import type { OverviewCounts, OverviewStore } from "./store";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

/** Something only the administrator can do anything about, and where to do it. */
export type Attention = {
  id: string;
  /** `action`: waiting on a decision. `watch`: not broken, but worth a look. */
  severity: "action" | "watch";
  title: string;
  detail: string;
  /** The screen that deals with it, as a path in the app. Null where there is no screen for it. */
  to: string | null;
};

export type Overview = {
  generatedAt: string;
  attention: Attention[];
  customers: {
    accounts: number;
    /** On a paid plan and paid up. */
    paying: number;
    /** A payment failed and the provider is retrying. */
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
  revenue: {
    /** Euro cents per month at list price, before tax, for accounts paying now. */
    monthlyRecurringCents: number;
  };
  now: {
    /** Runs in progress this moment. */
    runs: number;
    /** Accounts those runs belong to. */
    accounts: number;
    /** Background jobs waiting for a turn. */
    queuedWork: number;
  };
  /** Absent where this deployment does not run coworkers in Ark's cloud. */
  cloud: {
    mode: "included" | "metered";
    period: string;
    priced: boolean;
    accountsUsing: number;
    hours: number;
    /** What the month has cost Ark so far, in cents. */
    costCents: number;
    /** What it would be charged to customers if the month ended now, in cents. */
    chargeCents: number;
  } | null;
  checks: Check[];
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Worked out from the counts alone, so it can be tested without a database. */
export function attentionFrom(
  counts: OverviewCounts,
  pastDue: number,
): Attention[] {
  const items: Attention[] = [];
  if (counts.charges.uncertain > 0) {
    items.push({
      id: "charges-uncertain",
      severity: "action",
      title: "Cloud charges need your decision",
      detail: `${plural(counts.charges.uncertain, "month", "months")} where the payment service did not say whether it took the money. Look at Paddle's own record, then settle each one.`,
      to: "/admin/cloud",
    });
  }
  if (counts.charges.stuck > 0) {
    items.push({
      id: "charges-stuck",
      severity: "action",
      title: "Cloud charges stuck while being sent",
      detail: `${plural(counts.charges.stuck, "charge", "charges")} started over an hour ago and never recorded an answer. They are not retried; check Paddle, then settle them.`,
      to: "/admin/cloud",
    });
  }
  if (counts.marketplace.pendingListings > 0) {
    items.push({
      id: "marketplace-review",
      severity: "action",
      title: "Shared coworkers waiting for review",
      detail: `${plural(counts.marketplace.pendingListings, "listing is", "listings are")} not visible to anyone until you approve or reject ${counts.marketplace.pendingListings === 1 ? "it" : "them"}.`,
      to: "/admin/marketplace",
    });
  }
  if (counts.marketplace.openReports > 0) {
    items.push({
      id: "marketplace-reports",
      severity: "action",
      title: "Reported coworkers",
      detail: `${plural(counts.marketplace.openReports, "report is", "reports are")} open against shared coworkers.`,
      to: "/admin/marketplace",
    });
  }
  if (counts.work.gaveUp > 0) {
    items.push({
      id: "work-gave-up",
      severity: "action",
      title: "Background jobs gave up",
      detail: `${plural(counts.work.gaveUp, "job", "jobs")} ran out of attempts and will not run again. The reason is in the work_items table and the server log.`,
      to: null,
    });
  }
  if (pastDue > 0) {
    items.push({
      id: "accounts-past-due",
      severity: "watch",
      title: "Payments failing",
      detail: `${plural(pastDue, "account has", "accounts have")} a failed payment. The provider is retrying; they lose access if it does not clear.`,
      to: "/admin/accounts",
    });
  }
  if (counts.accounts.suspended > 0) {
    items.push({
      id: "accounts-suspended",
      severity: "watch",
      title: "Suspended accounts",
      detail: `${plural(counts.accounts.suspended, "account is", "accounts are")} suspended and cannot run coworkers.`,
      to: "/admin/accounts",
    });
  }
  return items;
}

/**
 * The administrator's overview: what needs a decision, how the service is doing right now, and what
 * is still to settle before customers can rely on it. Counts only, for staff only.
 */
export function adminOverviewRoutes(options: {
  requireUser: Middleware;
  store: OverviewStore;
  /** The deployment's settings, read on each request so a change shows without a restart of this page. */
  facts: () => Promise<DeploymentFacts> | DeploymentFacts;
  /** Present where coworkers can run in Ark's cloud. */
  cloud?: {
    mode: "included" | "metered";
    store: CloudStore;
    meter: CloudMeter;
  };
  now?: () => Date;
}) {
  const { requireUser, store, facts, cloud } = options;
  const now = options.now ?? (() => new Date());
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  app.get("/", async (context) => {
    const [counts, deployment] = await Promise.all([store.counts(), facts()]);

    const subscribed = (planId: string, status: string) =>
      counts.subscriptions
        .filter((row) => row.planId === planId && row.status === status)
        .reduce((sum, row) => sum + row.count, 0);
    const sold = PLANS.filter((plan) => plan.purchasable);
    const byPlan = sold.map((plan) => ({
      planId: plan.id,
      name: plan.name,
      priceEurCents: plan.priceEurCents,
      paying: subscribed(plan.id, "active"),
    }));
    const statusTotal = (status: string) =>
      counts.subscriptions
        .filter((row) => sold.some((plan) => plan.id === row.planId))
        .filter((row) => row.status === status)
        .reduce((sum, row) => sum + row.count, 0);
    const pastDue = statusTotal("past_due");

    let cloudSummary: Overview["cloud"] = null;
    if (cloud) {
      const period = periodOf(now());
      const usage = await monthlyUsage(
        { store: cloud.store, meter: cloud.meter },
        period,
      ).catch(() => undefined);
      if (usage) {
        cloudSummary = {
          mode: cloud.mode,
          period,
          priced: usage.priced,
          accountsUsing: usage.accounts.length,
          hours: usage.totals.hours,
          costCents: usage.totals.costCents,
          chargeCents: usage.totals.chargeCents,
        };
      }
    }

    const overview: Overview = {
      generatedAt: now().toISOString(),
      attention: attentionFrom(counts, pastDue),
      customers: {
        accounts: counts.accounts.total,
        paying: byPlan.reduce((sum, plan) => sum + plan.paying, 0),
        pastDue,
        canceled: statusTotal("canceled"),
        suspended: counts.accounts.suspended,
        newLast7Days: counts.accounts.newLast7Days,
        newLast30Days: counts.accounts.newLast30Days,
        people: counts.people.total,
        newPeopleLast7Days: counts.people.newLast7Days,
        byPlan,
      },
      revenue: {
        monthlyRecurringCents: byPlan.reduce(
          (sum, plan) => sum + plan.paying * plan.priceEurCents,
          0,
        ),
      },
      now: {
        runs: counts.running.runs,
        accounts: counts.running.accounts,
        queuedWork: counts.work.waiting,
      },
      cloud: cloudSummary,
      checks: goLiveChecks(deployment),
    };
    return context.json(overview);
  });

  return app;
}
