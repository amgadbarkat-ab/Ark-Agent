/**
 * The marketplace: Ark's own digital employees, which anyone can install, and coworkers people have
 * shared as guides, which can only be read. Decision D7.
 *
 * A listing is a snapshot, not a link. A shared listing holds inert text taken from a coworker at the
 * moment it was published and cleaned of secrets; nothing in the runtime ever loads it, which is
 * what makes "it never runs on anyone else's account" true by construction and not by a check.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { tenants } from "./tenants";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const listingKind = pgEnum("listing_kind", ["official", "shared"]);

export const listingStatus = pgEnum("listing_status", [
  "pending",
  "published",
  "rejected",
  "removed",
]);

export const reportStatus = pgEnum("report_status", [
  "open",
  "dismissed",
  "actioned",
]);

/** Who a listing is by. One per account that has shared something, and one for Ark itself. */
export const marketplacePublishers = pgTable(
  "marketplace_publishers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for Ark's own. Unique otherwise: one public face per account. */
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    /** What other people see. Chosen by the publisher; never an email address. */
    displayName: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    official: boolean("official").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("marketplace_publishers_tenant_key").on(table.tenantId),
    // Two publishers cannot look the same on the page. This, with the name rules in the store, is
    // what stops somebody publishing as "Ark" or as another customer.
    uniqueIndex("marketplace_publishers_name_key").on(
      sql`lower(${table.displayName})`,
    ),
  ],
);

export const marketplaceListings = pgTable(
  "marketplace_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: listingKind("kind").notNull(),
    /** The address of its page. Stable for an official listing; made from the title for a shared one. */
    slug: text("slug").notNull(),
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => marketplacePublishers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    category: text("category").notNull(),
    tags: text("tags").array().notNull().default([]),
    /** Markdown the publisher wrote for readers. */
    description: text("description").notNull().default(""),
    /**
     * What the listing shows or installs, as inert data.
     * Official: `{ install: { name, title, roleDescription }, suggestedTools: [...] }`.
     * Shared: `{ roleDescription, kind, tools: [refs], notes }`, cleaned. Never an endpoint, a key
     * or a token, and never anything an install could be built from.
     */
    content: jsonb("content").notNull(),
    status: listingStatus("status").notNull().default("pending"),
    /** Why it was rejected or removed, in words the publisher is shown. */
    reviewNote: text("review_note"),
    version: integer("version").notNull().default(1),
    /** Which of the publisher's coworkers it was taken from. Never shown to anybody else. */
    sourceAgentId: text("source_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    installCount: integer("install_count").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("marketplace_listings_slug_key").on(table.slug),
    index("marketplace_listings_browse_idx").on(
      table.status,
      table.kind,
      table.category,
    ),
    index("marketplace_listings_publisher_idx").on(table.publisherId),
  ],
);

/** An official listing put into somebody's account, kept so a count and a history exist. */
export const marketplaceInstalls = pgTable(
  "marketplace_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => marketplaceListings.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The coworker it became. Set null when that coworker is deleted; the install stays on record. */
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("marketplace_installs_listing_idx").on(table.listingId)],
);

export const marketplaceReports = pgTable(
  "marketplace_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => marketplaceListings.id, { onDelete: "cascade" }),
    reporterUserId: text("reporter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    details: text("details").notNull().default(""),
    status: reportStatus("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (table) => [
    // One report per person per listing, so a report is a voice and not a way to spam the queue.
    uniqueIndex("marketplace_reports_once_key").on(
      table.listingId,
      table.reporterUserId,
    ),
    index("marketplace_reports_open_idx").on(table.status, table.createdAt),
  ],
);
