/**
 * Approving by phone (P2 idea 10, desk #90): where a person may be called, the PIN that proves it
 * is them, and which of their digital employees may call.
 *
 * Off by default twice over: the deployment mounts nothing without `PHONE_APPROVAL_ENABLED=true`,
 * and a person with no row here is never called. The PIN is stored as a salted scrypt hash.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";

export const phoneApprovalSettings = pgTable("phone_approval_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The number to ring, as the person typed it (E.164 checked on the way in). */
  phone: text("phone").notNull(),
  /** `scrypt$<salt hex>$<hash hex>`. Never the PIN. */
  pinHash: text("pin_hash").notNull(),
  /** The digital employees whose requests may ring this person. Empty rings for none. */
  agentIds: text("agent_ids").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
