/**
 * The phones and browsers a person has said may send them a notification.
 *
 * One row per browser on one device. The `endpoint` is the push service's address for it (Google's,
 * Mozilla's or Apple's) and is what a message is sent to, so it is unique: the same browser signing in
 * as somebody else moves the row to them rather than notifying both. `p256dh` and `auth` are that
 * browser's public key and shared secret for encrypting what is sent, which only this server and that
 * browser hold; they are never returned by the API. The rows go with the person.
 */
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_key").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId, table.createdAt),
  ],
);
