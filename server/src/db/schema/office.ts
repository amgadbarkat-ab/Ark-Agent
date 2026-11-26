import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The office network (Amgad, 24 Nov 2026, option A): the administrator's computer is the company's
 * ArkAgent, and staff computers on the same network sign in to it over HTTPS. One row: whether it is
 * switched on, and the certificate this ArkAgent made for itself. Staff computers trust that exact
 * certificate, by its SHA-256 fingerprint in the join code, and no other.
 *
 * `sealedKey` is the certificate's private key, sealed with KEY_ENCRYPTION_KEY like every other
 * secret here (see rekey.ts).
 */
export const officeNetwork = pgTable("office_network", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  certificate: text("certificate").notNull(),
  sealedKey: text("sealed_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  /**
   * Remote staff (v0.1.56): staff away from the office reach this ArkAgent through BlackArk's staff
   * relay. Off until the administrator switches it on. `relayOffice` is this office's random id at
   * the relay; `sealedRelay` holds its host key and the staff access key, as JSON, sealed with
   * KEY_ENCRYPTION_KEY (rekey.ts).
   */
  remoteEnabled: boolean("remote_enabled").notNull().default(false),
  relayOffice: text("relay_office"),
  sealedRelay: text("sealed_relay"),
  /** Whether the relay has welcomed this office as this computer's: only then does a code name it. */
  relayRegistered: boolean("relay_registered").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
