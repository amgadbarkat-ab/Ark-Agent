/**
 * A customer trial on this install (#109, v0.1.37), and the check-ins BlackArk's own server receives.
 *
 * One trial per install: `trial_state` has at most one row, keyed "install". What the signed profile
 * said is kept as it was signed (`profile`, `signature`), so the state can always be checked again
 * against the key; the columns beside it are what was read from it, and what unlock codes changed.
 */
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const trialState = pgTable("trial_state", {
  id: text("id").primaryKey().default("install"),
  customerId: text("customer_id").notNull(),
  customerName: text("customer_name").notNull(),
  /** The signed text and its signature, exactly as imported. */
  profile: text("profile").notNull(),
  signature: text("signature").notNull(),
  issuedAt: at("issued_at").notNull(),
  startsAt: at("starts_at").notNull(),
  /** The end the profile gave. An unlock code moves `endsOverrideAt`, never this. */
  endsAt: at("ends_at").notNull(),
  endsOverrideAt: at("ends_override_at"),
  planId: text("plan_id").notNull(),
  createBlocked: boolean("create_blocked").notNull(),
  checkInUrl: text("check_in_url"),
  /** "trial" until a paid code is entered, then "paid": no end, no block. */
  status: text("status").notNull().default("trial"),
  /**
   * The latest time this install has seen. A clock turned back does not turn the trial back: the
   * end is compared with whichever is later, this or the clock.
   */
  latestSeenAt: at("latest_seen_at").notNull().defaultNow(),
  /** Random, made once; what a check-in calls this install. Never anything about the person. */
  installId: uuid("install_id").notNull().defaultRandom(),
  lastCheckInAt: at("last_check_in_at"),
  lastCheckInError: text("last_check_in_error"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

/** Each roster employee, once set up. Kept after a person deletes one, so it is not set up again. */
export const trialRoster = pgTable("trial_roster", {
  key: text("key").primaryKey(),
  agentId: text("agent_id").notNull(),
  seededAt: at("seeded_at").notNull().defaultNow(),
});

/** Unlock codes used here. A code's nonce is its key, so the same code cannot work twice. */
export const trialCodes = pgTable("trial_codes", {
  nonce: text("nonce").primaryKey(),
  customerId: text("customer_id").notNull(),
  action: text("action").notNull(),
  until: at("until"),
  appliedAt: at("applied_at").notNull().defaultNow(),
});

/**
 * What installs report, on BlackArk's own server (ARK_TRIAL_RECEIVER=true). One row per install,
 * updated in place: status and days left, never anything a customer wrote.
 */
export const trialCheckIns = pgTable("trial_check_ins", {
  installId: uuid("install_id").primaryKey(),
  customerId: text("customer_id").notNull(),
  version: text("version").notNull(),
  status: text("status").notNull(),
  daysLeft: integer("days_left").notNull(),
  endsAt: at("ends_at"),
  employees: integer("employees"),
  firstSeenAt: at("first_seen_at").notNull().defaultNow(),
  lastSeenAt: at("last_seen_at").notNull().defaultNow(),
});

/**
 * How this install was activated (#109, v0.1.42): a trial activation code or a paid licence key, as
 * typed, with what was read from it. One row or none, keyed "install". A newer key for the same
 * customer replaces the row; the trial profile, when there is one, stays in `trial_state`.
 */
export const activationState = pgTable("activation_state", {
  id: text("id").primaryKey().default("install"),
  /** "trial" (a trial activation code) or "license" (a paid licence key). */
  kind: text("kind").notNull(),
  customerId: text("customer_id").notNull(),
  /** The signed text and its signature, exactly as typed. */
  payload: text("payload").notNull(),
  signature: text("signature").notNull(),
  nonce: text("nonce").notNull(),
  planId: text("plan_id").notNull(),
  seats: integer("seats"),
  /** Paid add-ons, comma-separated; empty for none. */
  addons: text("addons").notNull().default(""),
  issuedAt: at("issued_at").notNull(),
  /** The trial's last moment, or the licence's `validUntil`. */
  validUntil: at("valid_until").notNull(),
  renewUrl: text("renew_url"),
  /** As on `trial_state`: the latest time seen here, so turning the clock back changes nothing. */
  latestSeenAt: at("latest_seen_at").notNull().defaultNow(),
  /** Random, made once; what a renewal calls this install. */
  installId: uuid("install_id").notNull().defaultRandom(),
  lastRenewAt: at("last_renew_at"),
  lastRenewError: text("last_renew_error"),
  activatedAt: at("activated_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});
