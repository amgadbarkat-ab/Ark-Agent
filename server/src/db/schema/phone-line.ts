/**
 * Answering the business's phone line (#109): the one line this install answers, and its call log.
 *
 * The line token (from BlackArk's relay) and the speech key (the customer's own) are in the vault;
 * these rows hold pointers to them, never the secrets. The call log holds no audio and no
 * transcript: the time, the caller's number, the outcome, a one-line summary and any callback.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, credentials, users } from "./core";

/** Opening hours: per weekday (0 = Sunday), "HH:MM" from and to, in Europe/Athens. */
export type PhoneLineHours = Partial<
  Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", { from: string; to: string }>
>;

export const phoneLine = pgTable("phone_line", {
  /** Always "line": one line per install. */
  id: text("id").primaryKey(),
  relayUrl: text("relay_url").notNull(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  /** Whose employee answers, and whose callbacks they are. */
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  lineCredentialId: uuid("line_credential_id")
    .notNull()
    .references(() => credentials.id),
  speechCredentialId: uuid("speech_credential_id")
    .notNull()
    .references(() => credentials.id),
  speechModel: text("speech_model").notNull(),
  voice: text("voice").notNull(),
  greeting: text("greeting").notNull(),
  /** Null: always open. */
  hours: jsonb("hours").$type<PhoneLineHours>(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const phoneCalls = pgTable(
  "phone_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Twilio's call id; one row per call. */
    callId: text("call_id").notNull().unique(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    fromNumber: text("from_number").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    /** answered | callback | handed_over | after_hours | failed | in_progress */
    outcome: text("outcome").notNull().default("in_progress"),
    summary: text("summary").notNull().default(""),
    callbackName: text("callback_name"),
    callbackNumber: text("callback_number"),
    callbackReason: text("callback_reason"),
    callbackDoneAt: timestamp("callback_done_at", { withTimezone: true }),
  },
  (table) => [index("phone_calls_started_idx").on(table.startedAt)],
);

/**
 * The business's own price list (#109): the uploaded CSV or XLSX, as its header row and its rows,
 * each the text it was written with. One per install; a new upload replaces it.
 */
export const priceList = pgTable("price_list", {
  /** Always "list". */
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  header: text("header").notNull(),
  rows: text("rows").array().notNull(),
  uploadedBy: text("uploaded_by").references(() => users.id, {
    onDelete: "set null",
  }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
