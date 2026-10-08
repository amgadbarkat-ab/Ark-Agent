/**
 * Running coworkers in Ark's cloud: what it costs, who agreed to pay it, what was used, and what was
 * charged. Decision D5 in docs/ark/01-product-decisions.md; how it fits together is in
 * docs/ark/17-cloud-runtime.md.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import type {
  AgreementSegment,
  ChargePart,
  CloudRates,
  CloudUsage,
} from "../../../../shared/cloud-pricing";
import { users } from "./core";
import { tenants } from "./tenants";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * What a unit of cloud costs and what the payment provider keeps: one row, set by staff from measured
 * cost. Absent means nothing has been priced, and where cloud running is a paid add-on nobody can
 * switch it on, because nobody can be told what they are agreeing to.
 */
export const cloudRates = pgTable("cloud_rates", {
  /** Always `current`. A table of one row, so there is no way to have two prices at once. */
  id: text("id").primaryKey().default("current"),
  rates: jsonb("rates").$type<CloudRates>().notNull(),
  /** Who set it. Kept if they are erased, as nobody; the audit trail has the event. */
  setBy: text("set_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

/**
 * One account's agreement to pay for cloud running: whether it is on, the most they will spend in a
 * month, and the rates they were shown when they agreed.
 */
export const cloudAccounts = pgTable("cloud_accounts", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** The most that may be charged for one month, in cents. Cloud runs stop being accepted at it. */
  monthlyCapCents: integer("monthly_cap_cents"),
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  /** The rates on the screen when they said yes: what they agreed to, whatever they are later set to. */
  consentedRates: jsonb("consented_rates").$type<CloudRates>(),
  /**
   * Agreements that were replaced, oldest first: each is the prices the person had agreed to and the
   * stretch of time they applied. Staff changing the prices ends an agreement and asks again; what was
   * used in the meantime is still priced at what was agreed for it.
   */
  agreementHistory: jsonb("agreement_history")
    .$type<AgreementSegment[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: updatedAt(),
});

export const cloudSource = pgEnum("cloud_source", [
  "run",
  "computer",
  "storage",
]);

/**
 * A stretch of time during which some of the cloud was in use for one coworker.
 *
 * Three kinds, all intervals: a run that was working (`run`), a coworker's own computer being up
 * (`computer`), and a coworker's persistent storage existing (`storage`, which carries its size in
 * `bytes`). Compute is the union of the first two, so a run on a computer that is also up is not
 * counted twice.
 *
 * `last_seen_at` is what keeps a crash from becoming a bill. Whatever records an interval refreshes
 * it while the thing is alive, and an interval that was never closed is worth only up to the last time
 * anybody saw it, never "until now".
 */
export const cloudIntervals = pgTable(
  "cloud_intervals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    source: cloudSource("source").notNull(),
    /** The run id, or the computer's session, or the bot id for storage. Unique with the source. */
    ref: text("ref").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Storage only: how many bytes were held. */
    bytes: bigint("bytes", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("cloud_intervals_ref_idx").on(table.source, table.ref),
    index("cloud_intervals_tenant_idx").on(table.tenantId, table.startedAt),
    index("cloud_intervals_open_idx").on(table.endedAt),
    /*
     * One computer, and one storage, open at a time per coworker. Two server processes that both see
     * a computer come up insert the same row, and the second is a refresh of the first instead of a
     * second hour of the same hour. Runs are not held to this: a coworker may have several going.
     */
    uniqueIndex("cloud_intervals_one_open_idx")
      .on(table.source, table.botId)
      .where(sql`${table.endedAt} is null and ${table.source} <> 'run'`),
  ],
);

export const cloudChargeStatus = pgEnum("cloud_charge_status", [
  /** Worked out, not yet sent. */
  "pending",
  /** Being sent now. A row left here means the answer was lost: see `uncertain`. */
  "charging",
  "charged",
  /** The payment provider may or may not have taken it; a person decides, and it is never retried. */
  "uncertain",
  /** Under the minimum: its cost rides along with the next month's charge. */
  "carried",
  /** Staff decided not to charge it. */
  "waived",
]);

/**
 * One month's cloud charge for one account.
 *
 * Unique per account and month, which is what stops a second run of the monthly job charging the same
 * month twice. `charging` is written BEFORE the payment provider is asked, so a process that dies
 * between asking and recording leaves a row that says so, and the job never asks again for it.
 */
export const cloudCharges = pgTable(
  "cloud_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `2026-10`: the calendar month, in UTC, that the usage was in. */
    period: text("period").notNull(),
    status: cloudChargeStatus("status").notNull().default("pending"),
    usage: jsonb("usage").$type<CloudUsage>().notNull(),
    rates: jsonb("rates").$type<CloudRates>().notNull(),
    /** What the usage cost Ark, unrounded, in cents. What a later month carries forward. */
    costCents: numeric("cost_cents", { precision: 16, scale: 4 }).notNull(),
    /** What was (or will be) charged, in whole cents. Zero for carried and waived. */
    amountCents: integer("amount_cents").notNull().default(0),
    /** What the month was made of, one part for each agreement it touched. Null before parts existed. */
    parts: jsonb("parts").$type<ChargePart[]>(),
    providerRef: text("provider_ref"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("cloud_charges_period_idx").on(table.tenantId, table.period),
  ],
);
