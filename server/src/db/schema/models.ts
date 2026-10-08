import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * A person's connection to a language model: which provider, where it lives, and the key they gave
 * for it.
 *
 * Per person, not per deployment, so one person's key is never spent on another's conversations and
 * a person can change provider without asking an administrator. The key is stored encrypted and is
 * never returned by any route.
 */
export const modelConnections = pgTable(
  "model_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** An id from the provider catalogue in shared/model-providers.ts. */
    providerId: text("provider_id").notNull(),
    /** What the person calls it. */
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    /** Null for a provider that needs no key. */
    encryptedKey: text("encrypted_key"),
    /** The model used unless a bot says otherwise. */
    model: text("model").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("model_connections_user_idx").on(table.userId, table.createdAt),
    // At most one default per person, enforced by the database rather than hoped for.
    uniqueIndex("model_connections_one_default_idx")
      .on(table.userId)
      .where(sql`${table.isDefault}`),
  ],
);
