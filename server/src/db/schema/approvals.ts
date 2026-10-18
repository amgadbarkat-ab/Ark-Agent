/**
 * Approvals: a change one digital employee wants made to another's work, waiting for a person.
 *
 * Its own file, by owner, like the other schema files. The table holds what was asked and what was
 * decided; the change itself is applied by the store when, and only when, the owner approves.
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents, users } from "./core";

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    /** The person who decides. The owner of the digital employees involved. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The digital employee that asked. */
    requestedByAgentId: text("requested_by_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** What kind of change, as the store's executors name it: `routine.update`, `routine.delete`, … */
    kind: text("kind").notNull(),
    /** The colleague whose work it changes, when there is one. */
    targetAgentId: text("target_agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    /** A routine id, a memory id: the thing changed. Not a foreign key, so a deleted thing still reads. */
    targetId: text("target_id"),
    /** What the person reads before deciding. Written by the store from the change, never by the model alone. */
    summary: text("summary").notNull(),
    /** What to apply on approval. Opaque outside the executor that owns the kind. */
    payload: jsonb("payload").notNull(),
    /** pending | approved | rejected | expired | failed. A text column, so a new state is not a migration. */
    status: text("status").notNull().default("pending"),
    /** What happened when it was applied, or why it could not be. */
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
  },
  (table) => [
    index("approvals_owner_status_idx").on(
      table.ownerUserId,
      table.status,
      table.createdAt,
    ),
    index("approvals_requested_by_idx").on(
      table.requestedByAgentId,
      table.status,
    ),
  ],
);
