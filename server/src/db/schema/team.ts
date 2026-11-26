/**
 * A customer's team on one ArkAgent (Amgad, 24 Nov 2026, #149): the administrator, made when the
 * deployment is first set up, and the staff sub-profiles the administrator adds, each paid for
 * (EUR 15 a month) before it can sign in.
 *
 * `subprofile_agents` is which digital employees each sub-profile may use. Its primary key is the
 * EMPLOYEE, so one employee belongs to at most one sub-profile, whatever the app sends and however
 * many administrators act at once: a second assignment is refused by the database itself, and moving
 * an employee is one update of its row.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const teamMemberKind = pgEnum("team_member_kind", [
  "admin",
  "subprofile",
]);

/**
 * pending_payment: made, not paid for yet, cannot sign in. active: paid, can sign in. suspended: a
 * renewal failed. removed: taken off the team by the administrator.
 */
export const teamMemberStatus = pgEnum("team_member_status", [
  "pending_payment",
  "active",
  "suspended",
  "removed",
]);

export const teamMembers = pgTable(
  "team_members",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: teamMemberKind("kind").notNull(),
    status: teamMemberStatus("status").notNull(),
    /** Set for a sub-profile made with an initial password: it must choose its own at first sign-in. */
    mustChangePassword: boolean("must_change_password")
      .notNull()
      .default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull().defaultNow(),
    activatedAt: at("activated_at"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [
    /**
     * Exactly one administrator per ArkAgent, held by the database: two set-ups at the same moment
     * cannot both make one (security review of v0.1.54, 25 Nov 2026).
     */
    uniqueIndex("team_members_one_administrator")
      .on(table.kind)
      .where(sql`${table.kind} = 'admin'`),
  ],
);

export const subprofileAgents = pgTable("subprofile_agents", {
  /** One row per employee: the database refuses a second sub-profile for it. */
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  assignedBy: text("assigned_by"),
  assignedAt: at("assigned_at").notNull().defaultNow(),
});
