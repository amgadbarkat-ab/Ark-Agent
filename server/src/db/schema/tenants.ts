/**
 * The customer boundary: who pays, what they pay for, and how much of it is in use.
 *
 * A tenant is what the app calls an account. The table is not called `accounts` because that name
 * is taken by the sign-in library, where it means one login method of one person.
 *
 * Built for several people under one tenant even though every plan is one user today (decision D3):
 * the person-to-tenant link is its own table rather than a column on the user, so shared seats later
 * add rows and rules, not a migration of every table that points at a user.
 */
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import { users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);

export const tenantRole = pgEnum("tenant_role", ["owner", "admin", "member"]);

export const subscriptionStatus = pgEnum("subscription_status", [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** What the customer sees: their email or company name. Free text, never used for access. */
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("active"),
  /** Why we suspended it, in words the customer is shown. Null while active. */
  suspendedReason: text("suspended_reason"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: tenantRole("role").notNull().default("owner"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index("tenant_memberships_user_idx").on(table.userId),
  ],
);

/**
 * What a tenant has bought. One row per tenant: the plan, whether it is paid up, and where the
 * payment provider keeps the matching record.
 *
 * `provider` is "manual" for the internal plan and for anything an administrator set by hand; the
 * rest are named after the payment provider once one is chosen (open question 2).
 */
export const subscriptions = pgTable("subscriptions", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** An id from shared/plans.ts. Not a foreign key: the catalogue is code. */
  planId: text("plan_id").notNull(),
  status: subscriptionStatus("status").notNull(),
  provider: text("provider").notNull().default("manual"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /**
   * When the payment provider says the last change it told us about happened.
   *
   * Providers deliver late and out of order. A subscription that was cancelled and then renewed must
   * not be left cancelled because the older notice arrived second, so a change that happened before
   * this is ignored. Kept as text so a provider's microseconds survive; a JavaScript date has only
   * milliseconds.
   */
  lastEventAt: timestamp("last_event_at", {
    withTimezone: true,
    mode: "string",
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One bot working on one run, for as long as it is working.
 *
 * The quota is "how many different bots are working at once", counted from these rows. They are
 * leases rather than a counter so that a crashed process cannot hold a place forever: each is kept
 * alive by a heartbeat and simply stops counting when it expires.
 */
export const runSlots = pgTable(
  "run_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    runId: text("run_id").notNull(),
    userId: text("user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("run_slots_run_key").on(table.tenantId, table.runId),
    index("run_slots_live_idx").on(table.tenantId, table.expiresAt),
  ],
);

/**
 * What a payment provider told us, kept so a repeated delivery is recognised and so a dispute can be
 * answered from our own records. Written by the billing webhook only.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    /** The provider's own id for the event; unique per provider, so a retry is a no-op. */
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(1),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_events_provider_event_key").on(
      table.provider,
      table.eventId,
    ),
  ],
);
