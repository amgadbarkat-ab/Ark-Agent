import { and, asc, desc, eq, gt, ilike, lt, or, sql } from "drizzle-orm";
import {
  type Plan,
  planById,
  type SubscriptionStatus,
  subscriptionAllowsRuns,
} from "../../../shared/plans";
import type { Database } from "../db/client";
import {
  runSlots,
  subscriptions,
  tenantMemberships,
  tenants,
  users,
} from "../db/schema";

/**
 * "internal": every account is on the unlimited internal plan and nobody pays. This is how a
 * company runs Ark for its own staff, and the default.
 * "subscriptions": accounts are created without a paid plan and cannot run bots until they have one.
 */
export type BillingMode = "internal" | "subscriptions";

export function billingModeFrom(value: string | undefined): BillingMode {
  return value?.trim().toLowerCase() === "subscriptions"
    ? "subscriptions"
    : "internal";
}

export type BlockedCode = "suspended" | "no_plan" | "canceled";

/** What an account is allowed to do right now, decided in one place. */
export type Entitlement = {
  tenantId: string;
  planId: string;
  planName: string;
  subscriptionStatus: SubscriptionStatus;
  /** How many different bots may work at once. Null means no limit. */
  maxActiveBots: number | null;
  /** Whether bots may run at all. */
  canRun: boolean;
  /** Why not, in words the customer is shown. Absent while they can. */
  blockedCode?: BlockedCode;
  blockedReason?: string;
};

export type AccountSummary = Entitlement & {
  tenantName: string;
  /** How many different bots are working right now. */
  activeBots: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string;
};

export type AdminTenantRow = {
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

export type SubscriptionChange = {
  planId?: string;
  status?: SubscriptionStatus;
  provider?: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
};

export type AccountStore = {
  /** The account this person belongs to, made if they have none yet. Safe to call repeatedly. */
  ensureTenant: (userId: string) => Promise<string>;
  tenantIdForUser: (userId: string) => Promise<string | undefined>;
  entitlementFor: (userId: string) => Promise<Entitlement>;
  summaryFor: (userId: string) => Promise<AccountSummary>;
  /** Change what a tenant has bought. Used by billing events and by administrators. */
  applySubscription: (
    tenantId: string,
    change: SubscriptionChange,
  ) => Promise<void>;
  suspend: (tenantId: string, reason: string) => Promise<void>;
  resume: (tenantId: string) => Promise<void>;
  tenantIdForProviderCustomer: (
    provider: string,
    customerId: string,
  ) => Promise<string | undefined>;
  /** One page of accounts for the administrator's screen, newest first. */
  listForAdmin: (query?: {
    search?: string;
    cursor?: string;
    limit?: number;
  }) => Promise<{ tenants: AdminTenantRow[]; nextCursor: string | null }>;
  readonly billingMode: BillingMode;
};

const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export function entitlementOf(
  tenant: {
    id: string;
    status: "active" | "suspended";
    suspendedReason: string | null;
  },
  subscription: { planId: string; status: SubscriptionStatus },
): Entitlement {
  const plan: Plan | undefined = planById(subscription.planId);
  const base = {
    tenantId: tenant.id,
    planId: subscription.planId,
    planName: plan?.name ?? subscription.planId,
    subscriptionStatus: subscription.status,
    maxActiveBots: plan ? plan.maxActiveBots : 0,
  };
  if (tenant.status === "suspended") {
    return {
      ...base,
      canRun: false,
      blockedCode: "suspended",
      blockedReason: tenant.suspendedReason
        ? `This account is suspended: ${tenant.suspendedReason}`
        : "This account is suspended. Contact support to restore it.",
    };
  }
  if (!subscriptionAllowsRuns(subscription.status)) {
    return {
      ...base,
      canRun: false,
      blockedCode: subscription.status === "canceled" ? "canceled" : "no_plan",
      blockedReason:
        subscription.status === "canceled"
          ? "Your subscription has ended. Choose a plan to start your digital employees again."
          : "Choose a plan to start your digital employees.",
    };
  }
  return { ...base, canRun: true };
}

export function createAccountStore(
  database: Database,
  options: { billingMode?: BillingMode } = {},
): AccountStore {
  const billingMode = options.billingMode ?? "internal";

  async function liveBots(tenantId: string): Promise<number> {
    const [row] = await database
      .select({
        count: sql<number>`count(distinct ${runSlots.botId})::int`,
      })
      .from(runSlots)
      .where(
        and(
          eq(runSlots.tenantId, tenantId),
          gt(runSlots.expiresAt, sql`now()`),
        ),
      );
    return row?.count ?? 0;
  }

  async function tenantIdForUser(userId: string) {
    const [row] = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, userId))
      .orderBy(asc(tenantMemberships.createdAt))
      .limit(1);
    return row?.tenantId;
  }

  async function ensureTenant(userId: string) {
    const existing = await tenantIdForUser(userId);
    if (existing) return existing;
    return database.transaction(async (tx) => {
      // Two requests from a brand-new person must not make two accounts for them.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`tenant-provision:${userId}`}))`,
      );
      const [again] = await tx
        .select({ tenantId: tenantMemberships.tenantId })
        .from(tenantMemberships)
        .where(eq(tenantMemberships.userId, userId))
        .limit(1);
      if (again) return again.tenantId;
      const [person] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person) throw new Error("No such person to make an account for.");
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: person.email })
        .returning({ id: tenants.id });
      if (!tenant) throw new Error("The account could not be created.");
      await tx
        .insert(tenantMemberships)
        .values({ tenantId: tenant.id, userId, role: "owner" });
      await tx
        .insert(subscriptions)
        .values(
          billingMode === "internal"
            ? { tenantId: tenant.id, planId: "internal", status: "active" }
            : { tenantId: tenant.id, planId: "agent", status: "incomplete" },
        );
      return tenant.id;
    });
  }

  async function load(tenantId: string) {
    const [row] = await database
      .select({
        id: tenants.id,
        name: tenants.name,
        status: tenants.status,
        suspendedReason: tenants.suspendedReason,
        planId: subscriptions.planId,
        subscriptionStatus: subscriptions.status,
        provider: subscriptions.provider,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      })
      .from(tenants)
      .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new Error("This account has no subscription record.");
    return row;
  }

  return {
    billingMode,
    tenantIdForUser,
    ensureTenant,

    async entitlementFor(userId) {
      const row = await load(await ensureTenant(userId));
      return entitlementOf(
        {
          id: row.id,
          status: row.status,
          suspendedReason: row.suspendedReason,
        },
        { planId: row.planId, status: row.subscriptionStatus },
      );
    },

    async summaryFor(userId) {
      const tenantId = await ensureTenant(userId);
      const row = await load(tenantId);
      return {
        ...entitlementOf(
          {
            id: row.id,
            status: row.status,
            suspendedReason: row.suspendedReason,
          },
          { planId: row.planId, status: row.subscriptionStatus },
        ),
        tenantName: row.name,
        activeBots: await liveBots(tenantId),
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        provider: row.provider,
      };
    },

    async applySubscription(tenantId, change) {
      if (change.planId !== undefined && !planById(change.planId)) {
        throw new Error(`Unknown plan: ${change.planId}`);
      }
      const set: Partial<typeof subscriptions.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (change.planId !== undefined) set.planId = change.planId;
      if (change.status !== undefined) set.status = change.status;
      if (change.provider !== undefined) set.provider = change.provider;
      if (change.providerCustomerId !== undefined)
        set.providerCustomerId = change.providerCustomerId;
      if (change.providerSubscriptionId !== undefined)
        set.providerSubscriptionId = change.providerSubscriptionId;
      if (change.currentPeriodEnd !== undefined)
        set.currentPeriodEnd = change.currentPeriodEnd;
      if (change.cancelAtPeriodEnd !== undefined)
        set.cancelAtPeriodEnd = change.cancelAtPeriodEnd;
      const done = await database
        .update(subscriptions)
        .set(set)
        .where(eq(subscriptions.tenantId, tenantId))
        .returning({ tenantId: subscriptions.tenantId });
      if (done.length === 0) throw new Error("No such account.");
    },

    async suspend(tenantId, reason) {
      const done = await database
        .update(tenants)
        .set({
          status: "suspended",
          suspendedReason: reason.trim() || null,
          suspendedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning({ id: tenants.id });
      if (done.length === 0) throw new Error("No such account.");
    },

    async resume(tenantId) {
      const done = await database
        .update(tenants)
        .set({
          status: "active",
          suspendedReason: null,
          suspendedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning({ id: tenants.id });
      if (done.length === 0) throw new Error("No such account.");
    },

    async tenantIdForProviderCustomer(provider, customerId) {
      const [row] = await database
        .select({ tenantId: subscriptions.tenantId })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.provider, provider),
            eq(subscriptions.providerCustomerId, customerId),
          ),
        )
        .limit(1);
      return row?.tenantId;
    },

    async listForAdmin(query = {}) {
      const limit = Math.min(Math.max(query.limit ?? 25, MIN_LIMIT), MAX_LIMIT);
      const filters = [];
      if (query.search?.trim()) {
        const like = `%${query.search.trim().replace(/[%_\\]/g, "\\$&")}%`;
        filters.push(or(ilike(tenants.name, like), ilike(users.email, like)));
      }
      if (query.cursor) {
        const [stamp, id] = query.cursor.split("|");
        const at = new Date(stamp ?? "");
        if (Number.isNaN(at.getTime()) || !id) {
          throw new Error("That page cursor is not valid.");
        }
        filters.push(
          or(
            lt(tenants.createdAt, at),
            and(eq(tenants.createdAt, at), lt(tenants.id, id)),
          ),
        );
      }
      const rows = await database
        .select({
          tenantId: tenants.id,
          name: tenants.name,
          ownerEmail: users.email,
          planId: subscriptions.planId,
          subscriptionStatus: subscriptions.status,
          status: tenants.status,
          suspendedReason: tenants.suspendedReason,
          createdAt: tenants.createdAt,
          activeBots: sql<number>`(
            select count(distinct ${runSlots.botId})::int from ${runSlots}
            where ${runSlots.tenantId} = ${tenants.id} and ${runSlots.expiresAt} > now()
          )`,
        })
        .from(tenants)
        .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
        .leftJoin(
          tenantMemberships,
          and(
            eq(tenantMemberships.tenantId, tenants.id),
            eq(tenantMemberships.role, "owner"),
          ),
        )
        .leftJoin(users, eq(users.id, tenantMemberships.userId))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(tenants.createdAt), desc(tenants.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        tenants: page.map((row) => ({
          tenantId: row.tenantId,
          name: row.name,
          ownerEmail: row.ownerEmail,
          planId: row.planId,
          subscriptionStatus: row.subscriptionStatus,
          suspended: row.status === "suspended",
          suspendedReason: row.suspendedReason,
          activeBots: row.activeBots,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > limit && last
            ? `${last.createdAt.toISOString()}|${last.tenantId}`
            : null,
      };
    },
  };
}
