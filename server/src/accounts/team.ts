/**
 * A customer's team on one ArkAgent (Amgad, 24 Nov 2026, #149).
 *
 * - SET UP: on a deployment with no administrator yet, the first person gives a name, an email and a
 *   password and becomes the administrator. An install that ran before this (one person, no sign-in)
 *   keeps everything: that person's own account is the one given the email and password.
 * - SUB-PROFILES: only the administrator adds staff, with a name, an email and an initial password the
 *   person must change at first sign-in, and the digital employees they may use (at least one; there
 *   is no "all"). Each is EUR 15 a month: it cannot sign in until BlackArk says it is paid
 *   (`TeamBilling`), and is suspended when a renewal fails.
 * - ONE EMPLOYEE, ONE SUB-PROFILE: `subprofile_agents` is keyed by the employee, so the database
 *   refuses a second sub-profile for it however the request arrives. Giving it to another sub-profile
 *   is refused unless the administrator confirmed the move (`move`), and then it moves.
 * - The administrator keeps every employee, and is not counted as an assignment.
 * - Sub-profiles cannot buy, see billing or plans, or manage people: their role is "user".
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { setRole } from "../auth/roles";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  sessions,
  subprofileAgents,
  teamMembers,
  tenantMemberships,
  users,
} from "../db/schema";

/** What the team needs from Better Auth: its password hashing and its user and account rows. */
export type TeamAuthContext = {
  password: {
    hash(password: string): Promise<string>;
    verify(data: { password: string; hash: string }): Promise<boolean>;
  };
  internalAdapter: {
    createUser(user: {
      email: string;
      name: string;
      emailVerified?: boolean;
    }): Promise<{ id: string }>;
    findUserByEmail(email: string): Promise<{ user: { id: string } } | null>;
    updateUser(userId: string, data: Record<string, unknown>): Promise<unknown>;
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
      password: string;
    }): Promise<unknown>;
    updatePassword(userId: string, password: string): Promise<void>;
    findAccounts(
      userId: string,
    ): Promise<Array<{ providerId: string; password?: string | null }>>;
  };
};

/** One person as BlackArk's board shows the team: no password, no conversation, nothing else. */
export type TeamRosterEntry = {
  name: string;
  email: string;
  role: "admin" | "subprofile";
  status: "pending_payment" | "active" | "suspended";
  createdAt: string;
  agents: number;
};

/** BlackArk's side of the EUR 15 sub-profiles: how many are paid for, and asking for a new number. */
export type TeamBilling = {
  /** Asks for `quantity` paid sub-profiles (prorated). A checkout address when it must be paid first. */
  request(
    quantity: number,
    members?: TeamRosterEntry[],
  ): Promise<{ paidQuantity: number; checkoutUrl: string | null }>;
  /** How many sub-profiles are paid for right now. */
  paid(members?: TeamRosterEntry[]): Promise<number>;
};

export class TeamError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "TeamError";
  }
}

export const MAX_SUBPROFILES = 50;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}$/;

export type TeamMemberView = {
  userId: string;
  name: string;
  email: string;
  role: "admin" | "subprofile";
  status: "pending_payment" | "active" | "suspended" | "removed";
  createdAt: string;
  mustChangePassword: boolean;
  agentIds: string[];
};

export type TeamService = ReturnType<typeof createTeamService>;

export function createTeamService(dependencies: {
  database: Database;
  authContext: () => Promise<TeamAuthContext>;
  billing?: () => TeamBilling | null;
  now?: () => number;
  /**
   * Told which employees were just given to a sub-profile, so anything they were doing on this
   * computer for the administrator (the administrator's own browser) is let go.
   */
  onAssigned?: (agentIds: string[]) => Promise<void> | void;
}) {
  const { database } = dependencies;
  const now = () => new Date((dependencies.now ?? Date.now)());

  function checkPerson(input: {
    name: string;
    email: string;
    password: string;
  }) {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (!name || name.length > 120) throw new TeamError("Write a name.");
    if (email.length > 254 || !EMAIL.test(email))
      throw new TeamError("Write a valid email address.");
    if (input.password.length < 10 || input.password.length > 128)
      throw new TeamError("The password must be 10 to 128 characters.");
    return { name, email, password: input.password };
  }

  async function hasAdmin(): Promise<boolean> {
    const [row] = await database
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.kind, "admin"))
      .limit(1);
    return row !== undefined;
  }

  async function member(userId: string) {
    const [row] = await database
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId));
    return row ?? null;
  }

  async function requireAdmin(actorId: string) {
    const row = await member(actorId);
    if (row?.kind !== "admin")
      throw new TeamError("Only the administrator can do this.", 403);
  }

  /** The company's employees: those owned by an administrator of this team. */
  async function companyAgents(): Promise<Set<string>> {
    const rows = await database
      .select({ agentId: agentProfiles.agentId })
      .from(agentProfiles)
      .innerJoin(teamMembers, eq(teamMembers.userId, agentProfiles.ownerUserId))
      .where(eq(teamMembers.kind, "admin"));
    return new Set(rows.map((row) => row.agentId));
  }

  /**
   * Gives `userId` exactly these employees. An employee another sub-profile has is refused (409, with
   * who has it) unless `move` says the administrator confirmed moving it.
   */
  async function assign(
    actorId: string,
    userId: string,
    agentIds: string[],
    move: boolean,
  ) {
    const wanted = [...new Set(agentIds)];
    if (wanted.length === 0)
      throw new TeamError(
        "Choose at least one digital employee for this person.",
      );
    const company = await companyAgents();
    const unknown = wanted.filter((id) => !company.has(id));
    if (unknown.length > 0)
      throw new TeamError(
        "One of those digital employees is not the company's.",
        400,
        {
          agentIds: unknown,
        },
      );
    await database.transaction(async (tx) => {
      const held = await tx
        .select({
          agentId: subprofileAgents.agentId,
          userId: subprofileAgents.userId,
          name: users.name,
        })
        .from(subprofileAgents)
        .innerJoin(users, eq(users.id, subprofileAgents.userId))
        .where(
          and(
            inArray(subprofileAgents.agentId, wanted),
            ne(subprofileAgents.userId, userId),
          ),
        )
        .for("update");
      if (held.length > 0 && !move)
        throw new TeamError(
          "Some of these digital employees belong to another person. Confirm to move them.",
          409,
          {
            conflicts: held.map((row) => ({
              agentId: row.agentId,
              fromUserId: row.userId,
              fromName: row.name,
            })),
          },
        );
      await tx.delete(subprofileAgents).where(
        and(
          eq(subprofileAgents.userId, userId),
          sql`${subprofileAgents.agentId} not in (${sql.join(
            wanted.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
      for (const agentId of wanted) {
        // Keyed by the employee: one row, one sub-profile. A confirmed move rewrites its owner.
        if (move) {
          await tx
            .insert(subprofileAgents)
            .values({ agentId, userId, assignedBy: actorId, assignedAt: now() })
            .onConflictDoUpdate({
              target: subprofileAgents.agentId,
              set: { userId, assignedBy: actorId, assignedAt: now() },
            });
          continue;
        }
        // Not confirmed: never take it from anybody, even one who got it a moment ago (two
        // administrators at once). The database decides who was first; the other is told.
        await tx
          .insert(subprofileAgents)
          .values({ agentId, userId, assignedBy: actorId, assignedAt: now() })
          .onConflictDoNothing();
        const [holder] = await tx
          .select({ userId: subprofileAgents.userId, name: users.name })
          .from(subprofileAgents)
          .innerJoin(users, eq(users.id, subprofileAgents.userId))
          .where(eq(subprofileAgents.agentId, agentId));
        if (holder && holder.userId !== userId)
          throw new TeamError(
            "Some of these digital employees belong to another person. Confirm to move them.",
            409,
            {
              conflicts: [
                { agentId, fromUserId: holder.userId, fromName: holder.name },
              ],
            },
          );
      }
    });
    await Promise.resolve(dependencies.onAssigned?.(agentIds)).catch(
      () => undefined,
    );
  }

  async function subprofileCount(): Promise<number> {
    const [row] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.kind, "subprofile"),
          ne(teamMembers.status, "removed"),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Matches who may sign in to what is paid: the oldest sub-profiles first, up to the paid number,
   * active; any beyond it pending (never paid) or suspended (was active).
   */
  async function applyPaid(paid: number) {
    const rows = await database
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.kind, "subprofile"),
          ne(teamMembers.status, "removed"),
        ),
      )
      .orderBy(asc(teamMembers.createdAt));
    for (const [index, row] of rows.entries()) {
      const next =
        index < paid
          ? "active"
          : row.status === "active" || row.status === "suspended"
            ? "suspended"
            : "pending_payment";
      if (next !== row.status)
        await database
          .update(teamMembers)
          .set({
            status: next,
            updatedAt: now(),
            ...(next === "active" && !row.activatedAt
              ? { activatedAt: now() }
              : {}),
          })
          .where(eq(teamMembers.userId, row.userId));
      if (next !== "active")
        await database.delete(sessions).where(eq(sessions.userId, row.userId));
    }
  }

  /** The team as BlackArk's board shows it. */
  async function roster(): Promise<TeamRosterEntry[]> {
    const rows = await database
      .select({
        userId: teamMembers.userId,
        kind: teamMembers.kind,
        status: teamMembers.status,
        createdAt: teamMembers.createdAt,
        name: users.name,
        email: users.email,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(ne(teamMembers.status, "removed"))
      .orderBy(asc(teamMembers.createdAt));
    const held = await database.select().from(subprofileAgents);
    const company = (await companyAgents()).size;
    return rows.map((row) => ({
      name: row.name ?? "",
      email: row.email,
      role: row.kind,
      status: row.status === "removed" ? "suspended" : row.status,
      createdAt: row.createdAt.toISOString(),
      agents:
        row.kind === "admin"
          ? company
          : held.filter((one) => one.userId === row.userId).length,
    }));
  }

  async function askBilling(quantity: number) {
    const billing = dependencies.billing?.() ?? null;
    const notActivated = {
      paidQuantity: 0,
      checkoutUrl: null,
      error: "Activate ArkAgent first: sub-profiles are paid through BlackArk.",
    };
    if (!billing) return notActivated;
    try {
      const answer = await billing.request(quantity, await roster());
      await applyPaid(answer.paidQuantity);
      return { ...answer, error: null };
    } catch (error) {
      if ((error as Error)?.name === "NotActivatedError") return notActivated;
      return {
        paidQuantity: 0,
        checkoutUrl: null,
        error: "BlackArk could not be reached. Try again in a few minutes.",
      };
    }
  }

  return {
    /** Whether this deployment still needs its administrator. */
    async setupNeeded(): Promise<boolean> {
      return !(await hasAdmin());
    },

    /**
     * Makes the administrator, once. On an install that already has its one person (single-user
     * before), that person is given the email and password, so their employees and chats stay theirs.
     */
    async setup(input: { name: string; email: string; password: string }) {
      const person = checkPerson(input);
      if (await hasAdmin())
        throw new TeamError(
          "This ArkAgent already has its administrator.",
          409,
        );
      const auth = await dependencies.authContext();
      const existing = await database
        .select({ id: users.id })
        .from(users)
        .limit(2);
      let userId: string;
      if (existing.length === 1 && existing[0]) {
        userId = existing[0].id;
        await auth.internalAdapter.updateUser(userId, {
          name: person.name,
          email: person.email,
          emailVerified: true,
        });
      } else {
        if (await auth.internalAdapter.findUserByEmail(person.email))
          throw new TeamError("That email address is already used here.", 409);
        userId = (
          await auth.internalAdapter.createUser({
            name: person.name,
            email: person.email,
            emailVerified: true,
          })
        ).id;
      }
      await auth.internalAdapter.linkAccount({
        userId,
        providerId: "credential",
        accountId: userId,
        password: await auth.password.hash(person.password),
      });
      await database
        .insert(teamMembers)
        .values({ userId, kind: "admin", status: "active", activatedAt: now() })
        .onConflictDoNothing();
      await setRole(database, userId, "admin");
      return { userId, email: person.email };
    },

    /** Everybody on the team, for the administrator. */
    async list(actorId: string): Promise<TeamMemberView[]> {
      await requireAdmin(actorId);
      const rows = await database
        .select({
          userId: teamMembers.userId,
          kind: teamMembers.kind,
          status: teamMembers.status,
          createdAt: teamMembers.createdAt,
          mustChangePassword: teamMembers.mustChangePassword,
          name: users.name,
          email: users.email,
        })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(ne(teamMembers.status, "removed"))
        .orderBy(asc(teamMembers.createdAt));
      const held = await database.select().from(subprofileAgents);
      return rows.map((row) => ({
        userId: row.userId,
        name: row.name ?? row.email,
        email: row.email,
        role: row.kind,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        mustChangePassword: row.mustChangePassword,
        agentIds: held
          .filter((one) => one.userId === row.userId)
          .map((one) => one.agentId),
      }));
    },

    /** Adds a staff sub-profile: made now, able to sign in once paid. */
    async addSubprofile(
      actorId: string,
      input: {
        name: string;
        email: string;
        password: string;
        agentIds: string[];
        move?: boolean;
      },
    ) {
      await requireAdmin(actorId);
      const person = checkPerson(input);
      if ((await subprofileCount()) >= MAX_SUBPROFILES)
        throw new TeamError(`At most ${MAX_SUBPROFILES} sub-profiles.`, 409);
      if (input.agentIds.length === 0)
        throw new TeamError(
          "Choose at least one digital employee for this person.",
        );
      const auth = await dependencies.authContext();
      if (await auth.internalAdapter.findUserByEmail(person.email))
        throw new TeamError("That email address is already used here.", 409);
      // The employees first: a refused move must not leave a half-made person behind.
      const company = await companyAgents();
      if (input.agentIds.some((id) => !company.has(id)))
        throw new TeamError(
          "One of those digital employees is not the company's.",
        );
      if (!input.move) {
        const held = await database
          .select({
            agentId: subprofileAgents.agentId,
            userId: subprofileAgents.userId,
            name: users.name,
          })
          .from(subprofileAgents)
          .innerJoin(users, eq(users.id, subprofileAgents.userId))
          .where(inArray(subprofileAgents.agentId, input.agentIds));
        if (held.length > 0)
          throw new TeamError(
            "Some of these digital employees belong to another person. Confirm to move them.",
            409,
            {
              conflicts: held.map((row) => ({
                agentId: row.agentId,
                fromUserId: row.userId,
                fromName: row.name,
              })),
            },
          );
      }
      const user = await auth.internalAdapter.createUser({
        name: person.name,
        email: person.email,
        emailVerified: true,
      });
      await auth.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await auth.password.hash(person.password),
      });
      await setRole(database, user.id, "user");
      // In the administrator's account, so the company's content and employees are theirs too.
      const [account] = await database
        .select({ tenantId: tenantMemberships.tenantId })
        .from(tenantMemberships)
        .where(eq(tenantMemberships.userId, actorId))
        .limit(1);
      if (account)
        await database
          .insert(tenantMemberships)
          .values({
            tenantId: account.tenantId,
            userId: user.id,
            role: "member",
          })
          .onConflictDoNothing();
      await database.insert(teamMembers).values({
        userId: user.id,
        kind: "subprofile",
        status: "pending_payment",
        mustChangePassword: true,
        createdBy: actorId,
      });
      await assign(actorId, user.id, input.agentIds, input.move === true);
      const billing = await askBilling(await subprofileCount());
      return { userId: user.id, ...billing };
    },

    /** Changes which employees a sub-profile has: applies on its next request. */
    async setAgents(
      actorId: string,
      userId: string,
      agentIds: string[],
      move: boolean,
    ) {
      await requireAdmin(actorId);
      const row = await member(userId);
      if (row?.kind !== "subprofile" || row.status === "removed")
        throw new TeamError("No such sub-profile.", 404);
      await assign(actorId, userId, agentIds, move);
    },

    /** Takes a sub-profile off the team: signed out, employees freed, one fewer paid (prorated). */
    async remove(actorId: string, userId: string) {
      await requireAdmin(actorId);
      const row = await member(userId);
      if (row?.kind !== "subprofile" || row.status === "removed")
        throw new TeamError("No such sub-profile.", 404);
      await database
        .update(teamMembers)
        .set({ status: "removed", updatedAt: now() })
        .where(eq(teamMembers.userId, userId));
      await database
        .delete(subprofileAgents)
        .where(eq(subprofileAgents.userId, userId));
      await database.delete(sessions).where(eq(sessions.userId, userId));
      return askBilling(await subprofileCount());
    },

    /** BlackArk's paid number, applied: pending ones activate once paid, unpaid ones are suspended. */
    async syncBilling() {
      const billing = dependencies.billing?.() ?? null;
      if (!billing) return;
      // Nothing to ask while nobody but the administrator is on the team: off by default.
      if ((await subprofileCount()) === 0) return;
      try {
        await applyPaid(await billing.paid(await roster()));
      } catch {
        // Not activated, or BlackArk not reachable: the next run asks again; nobody is changed.
      }
    },

    /** Whether this person may use ArkAgent now: the administrator, or an active sub-profile. */
    async mayUse(
      userId: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
      const row = await member(userId);
      if (!row || row.kind === "admin" || row.status === "active")
        return { ok: true };
      return {
        ok: false,
        reason:
          row.status === "pending_payment"
            ? "This sub-profile is not active yet: your administrator's payment for it has not gone through."
            : row.status === "suspended"
              ? "This sub-profile is suspended: the last payment for it did not go through. Ask your administrator."
              : "This sub-profile was removed by your administrator.",
      };
    },

    /** Whether this employee is given to a sub-profile, who works with it from another computer. */
    async isAssigned(agentId: string) {
      const [row] = await database
        .select({ userId: subprofileAgents.userId })
        .from(subprofileAgents)
        .where(eq(subprofileAgents.agentId, agentId));
      return row !== undefined;
    },

    /** A staff sub-profile (any status): never buys, never sees billing, never manages people. */
    async isSubprofile(userId: string) {
      return (await member(userId))?.kind === "subprofile";
    },

    /** The person's own standing, for the app: role, and whether they must choose a new password. */
    async me(userId: string) {
      const row = await member(userId);
      return {
        role: row?.kind ?? "admin",
        status: row?.status ?? "active",
        mustChangePassword: row?.mustChangePassword ?? false,
      };
    },

    /** The first sign-in's new password, checked against the initial one. */
    async changePassword(userId: string, current: string, next: string) {
      if (next.length < 10 || next.length > 128)
        throw new TeamError("The password must be 10 to 128 characters.");
      const auth = await dependencies.authContext();
      const account = (await auth.internalAdapter.findAccounts(userId)).find(
        (one) => one.providerId === "credential",
      );
      if (
        !account?.password ||
        !(await auth.password.verify({
          password: current,
          hash: account.password,
        }))
      )
        throw new TeamError("The current password is not right.", 403);
      await auth.internalAdapter.updatePassword(
        userId,
        await auth.password.hash(next),
      );
      await database
        .update(teamMembers)
        .set({ mustChangePassword: false, updatedAt: now() })
        .where(eq(teamMembers.userId, userId));
    },

    /** Whether an employee is the company's (for the routes). */
    async agentExists(agentId: string): Promise<boolean> {
      const [row] = await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId));
      return row !== undefined;
    },
  };
}
