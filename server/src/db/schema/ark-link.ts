/**
 * Ark Link (#149): how phones reach this install through BlackArk's relay.
 *
 * The install token BlackArk issued is in the vault; the row holds a pointer. Each paired phone is
 * kept by name and by the SHA-256 of its device token, never the token itself.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { credentials, users } from "./core";

export const arkLink = pgTable("ark_link", {
  /** Always "link": one relay connection per install. */
  id: text("id").primaryKey(),
  relayUrl: text("relay_url").notNull(),
  installCredentialId: uuid("install_credential_id")
    .notNull()
    .references(() => credentials.id),
  /** Off by default; an administrator switches it on. */
  enabled: boolean("enabled").notNull().default(false),
  updatedBy: text("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const arkLinkDevices = pgTable("ark_link_devices", {
  id: text("id").primaryKey(),
  /** What the person confirmed at the desktop, e.g. "Μαρία's Pixel". */
  name: text("name").notNull(),
  tokenSha256: text("token_sha256").notNull().unique(),
  pairedBy: text("paired_by").references(() => users.id, {
    onDelete: "set null",
  }),
  pairedAt: timestamp("paired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /**
   * Who the phone acts as (#149, PE 18 Nov): the person who confirmed it, or the person an
   * administrator paired it for. Every request from the phone is that person's, with their role as it
   * is at that moment. Removing the person removes the phone. Null on a row from before this column,
   * which acts as nobody and is refused.
   */
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  /**
   * When that person accepted the phone. Set at once when they confirmed it themselves; for a phone an
   * administrator paired for somebody else, null until that person accepts it on their own computer,
   * and the phone does nothing until then.
   */
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});
