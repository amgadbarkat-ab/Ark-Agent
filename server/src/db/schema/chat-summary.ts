/**
 * Weekly summary, then chat cleanup (Amgad, 24 Nov 2026, #149): for each person and each digital
 * employee, the summary file the employee starts every request from, and whether the weekly cleanup
 * is on.
 *
 * One row per person and employee. `summary` is the file itself, merged week on week. `pending_threads`
 * and `pending_channels` are the conversations already summarised but not yet deleted, so a delete that
 * fails half way is finished next run, never summarised twice. The cleanup is on for an employee made
 * after this feature arrived (`chat_summary_epoch`), and off for one that already existed, so nobody's
 * existing chats are deleted without their choice; either can be switched in Settings.
 */
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const agentChatSummaries = pgTable(
  "agent_chat_summaries",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Null: the default (on for an employee made after the epoch). */
    enabled: boolean("enabled"),
    summary: text("summary").notNull().default(""),
    /** About how many tokens the summary is (characters / 4), for the setting and the report. */
    summaryTokens: integer("summary_tokens").notNull().default(0),
    /** The person's own time zone, from their browser, so the run is outside their business hours. */
    timezone: text("timezone"),
    summarisedAt: at("summarised_at"),
    lastAttemptAt: at("last_attempt_at"),
    lastError: text("last_error"),
    pendingThreads: text("pending_threads").array().notNull().default([]),
    pendingChannels: text("pending_channels").array().notNull().default([]),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

/** When this install first ran with the feature: employees made after it have the cleanup on. */
export const chatSummaryEpoch = pgTable("chat_summary_epoch", {
  id: text("id").primaryKey().default("epoch"),
  startedAt: at("started_at").notNull().defaultNow(),
});
