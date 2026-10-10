/**
 * Which version of the terms of service each person accepted, and when.
 *
 * One row per person per version, so a new version is a new row and the earlier acceptances stay as
 * the record of what was agreed then. Nothing else is kept: the evidence needed is which text, who,
 * and when. The row goes with the person (docs/ark/14-data-protection.md).
 */
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";

export const termsAcceptances = pgTable(
  "terms_acceptances",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The version line of the document they accepted (docs/legal/terms-of-service.md). */
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.version] })],
);
