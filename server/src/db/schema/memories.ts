/**
 * Memories: short things a digital employee keeps in mind between conversations.
 *
 * Its own file, by owner, like the other schema files. A memory belongs to one digital employee and,
 * through it, to one person; it is read into the employee's standing instruction on every run, so it
 * is kept short and counted.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents, users } from "./core";

export const agentMemories = pgTable(
  "agent_memories",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** The agent's owner when it was kept. The person who may read, change and delete it. */
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** Who put it there: `agent` (it chose to), `person` (the owner typed it) or `approved` (a lead asked, the owner agreed). */
    source: text("source").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_memories_agent_idx").on(table.agentId, table.createdAt),
  ],
);
