/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { tenants } from "./tenants";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: agentVisibility("visibility").notNull(),
    /**
     * Whose account this coworker belongs to. Null for the platform's own (the ones a deployment
     * ships), which have no owner and are offered to everybody.
     *
     * What "public" means depends on it: a platform coworker that is public is public to everyone,
     * but a customer's coworker that is public is public to the people in that customer's account
     * and nobody else. Without this a customer sharing a coworker with their own team would be
     * sharing it with every other customer.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    /**
     * Where this coworker runs: in Ark's cloud (the default, and the only place a hosted deployment
     * can run it) or on the person's own computer, where the desktop app runs it and it costs Ark
     * nothing (decision D5). A coworker set to the computer is refused on the hosted service, with
     * the way to change it, rather than quietly run somewhere that costs money.
     */
    runLocation: text("run_location").notNull().default("cloud"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
    index("agent_profiles_tenant_idx").on(table.tenantId),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const routineRunStatus = pgEnum("routine_run_status", [
  "succeeded",
  "failed",
  "skipped",
]);

/**
 * A standing instruction one person gave one Bot, on a schedule.
 *
 * Owned rows all the way down: the owner is who the headless turn runs as, so the routine can do
 * exactly what its owner could do in chat and nothing more. The channel is where the reply lands.
 */
export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Not a foreign key. Channels soft-delete (`channels.deletedAt`), and a routine pointing at a
     * deleted channel must survive to be shown as broken rather than vanish in a cascade.
     */
    channelId: text("channel_id").notNull(),
    instruction: text("instruction").notNull(),
    /** Five-field cron. Validated at the tool boundary; never parsed by the client. */
    cron: text("cron").notNull(),
    /** IANA zone the cron is read in. UTC when the person never said otherwise. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    /** The sweep's read target. Recomputed on every write and CAS-advanced by the sweep. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    /**
     * The last occurrence stamp the sweep advanced past — fired OR silently drained as stale.
     * Not "when this last ran": the run history lives in routine_runs, and everything a person
     * sees reads that table. This is the scheduler's own bookmark, kept because a CAS needs the
     * value it compared against recorded somewhere a human can inspect when a clock looks wrong.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("routines_due_idx").on(table.enabled, table.nextRunAt),
    /** Owner-scoped reads and writes: listFor, countEnabled, and the users cascade all hit this. */
    index("routines_by_owner_idx").on(table.ownerUserId, table.enabled),
  ],
);

export const routineSweeps = pgTable("routine_sweeps", {
  id: text("id").primaryKey(),
  sweptAt: timestamp("swept_at", { withTimezone: true }).notNull().defaultNow(),
  owner: text("owner"),
});

/** One row per firing, which is what the page's "last ran" and the fatigue rule read. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Null means the firing is still in flight; only a finished run has succeeded/failed/skipped. */
    status: routineRunStatus("status"),
    /** The refusal or the throw, capped like audit payloads. Never shown raw to a person. */
    error: text("error"),
  },
  (table) => [
    index("routine_runs_by_routine_idx").on(table.routineId, table.startedAt),
  ],
);
