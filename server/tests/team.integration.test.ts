import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  createTeamService,
  type TeamAuthContext,
  type TeamBilling,
} from "../src/accounts/team";
import { visibleAgentProfiles } from "../src/accounts/visibility";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agentProfiles,
  agents,
  sessions,
  subprofileAgents,
  teamMembers,
  tenantMemberships,
  tenants,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made = {
  users: [] as string[],
  agents: [] as string[],
  tenants: [] as string[],
};

async function clearTeam() {
  // The team is per deployment: these tests own it while they run.
  await database.delete(subprofileAgents);
  await database.delete(teamMembers);
}
beforeEach(clearTeam);
afterAll(async () => {
  await clearTeam();
  if (made.agents.length)
    await database.delete(agents).where(inArray(agents.id, made.agents));
  if (made.users.length)
    await database.delete(users).where(inArray(users.id, made.users));
  if (made.tenants.length)
    await database.delete(tenants).where(inArray(tenants.id, made.tenants));
  await database.$client.close();
});

const hash = (password: string) =>
  createHash("sha256").update(password).digest("hex");

/** Better Auth's part, in the same tables it uses, with a plain hash for the test. */
const authContext = async (): Promise<TeamAuthContext> => ({
  password: {
    hash: async (password) => hash(password),
    verify: async ({ password, hash: stored }) => hash(password) === stored,
  },
  internalAdapter: {
    async createUser(user) {
      const id = `user-${randomUUID()}`;
      await database.insert(users).values({ id, ...user });
      made.users.push(id);
      return { id };
    },
    async findUserByEmail(email) {
      const [row] = await database
        .select()
        .from(users)
        .where(eq(users.email, email));
      return row ? { user: { id: row.id } } : null;
    },
    async updateUser(userId, data) {
      await database.update(users).set(data).where(eq(users.id, userId));
    },
    async linkAccount(account) {
      await database.insert(accounts).values({ id: randomUUID(), ...account });
    },
    async updatePassword(userId, password) {
      await database
        .update(accounts)
        .set({ password })
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.providerId, "credential"),
          ),
        );
    },
    async findAccounts(userId) {
      return database
        .select()
        .from(accounts)
        .where(eq(accounts.userId, userId));
    },
  },
});

function billing(start = 0) {
  let paid = start;
  const asked: number[] = [];
  const rosters: unknown[] = [];
  const bill: TeamBilling & {
    setPaid(n: number): void;
    asked: number[];
    rosters: unknown[];
  } = {
    asked,
    rosters,
    setPaid: (n) => {
      paid = n;
    },
    async request(quantity, members) {
      asked.push(quantity);
      rosters.push(members);
      return {
        paidQuantity: paid,
        checkoutUrl:
          paid < quantity ? "https://checkout.stripe.com/c/pay/x" : null,
      };
    },
    async paid() {
      return paid;
    },
  };
  return bill;
}

async function service(bill = billing(), soleUser: string | null = null) {
  const assigned: string[][] = [];
  return {
    team: createTeamService({
      database,
      authContext,
      billing: () => bill,
      // Not the shared test database's count of people, which other tests change.
      soleUser: async () => soleUser,
      onAssigned: (agentIds) => {
        assigned.push(agentIds);
      },
    }),
    bill,
    assigned,
  };
}

/** The administrator and the company's employees, owned by them in their account. */
async function company(
  team: Awaited<ReturnType<typeof service>>["team"],
  count = 3,
) {
  const { userId: adminId } = await team.setup({
    name: "Maria",
    email: `admin-${randomUUID()}@shop.example`,
    password: "first-password-1",
  });
  made.users.push(adminId);
  const [tenant] = await database
    .insert(tenants)
    .values({ name: "Demo Shop" })
    .returning({ id: tenants.id });
  made.tenants.push(tenant?.id as string);
  await database
    .insert(tenantMemberships)
    .values({ tenantId: tenant?.id as string, userId: adminId, role: "owner" });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `agent-${randomUUID()}`;
    await database.insert(agents).values({
      id,
      name: `Employee ${i}`,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: adminId,
      tenantId: tenant?.id,
      title: "",
      roleDescription: "",
      avatarSeed: id,
      visibility: "private",
    });
    made.agents.push(id);
    ids.push(id);
  }
  return { adminId, agentIds: ids };
}

const madeUsers = (id: string) => {
  made.users.push(id);
};

const staff = (email: string, agentIds: string[], move?: boolean) => ({
  name: "Nikos",
  email,
  password: "initial-password-1",
  agentIds,
  ...(move === undefined ? {} : { move }),
});

describe("a customer's team", () => {
  test("set-up makes the administrator once; an install with its one person keeps that person", async () => {
    const { team } = await service();
    expect(await team.setupNeeded()).toBe(true);
    const { adminId } = await company(team, 0);
    expect(await team.setupNeeded()).toBe(false);
    expect(await team.me(adminId)).toMatchObject({
      role: "admin",
      status: "active",
    });
    const [role] = await database
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, adminId));
    expect(role?.role).toBe("admin");
    await expect(
      team.setup({
        name: "X",
        email: "x@x.example",
        password: "another-pass-1",
      }),
    ).rejects.toThrow("already has its administrator");
  });

  test("an install with its one person keeps that person, and their password is replaced, never doubled", async () => {
    const id = `user-${randomUUID()}`;
    await database
      .insert(users)
      .values({ id, email: `dev-${randomUUID()}@openbot.local`, name: "dev" });
    made.users.push(id);
    // A set-up begun before and retried: that person already has a password here.
    await database.insert(accounts).values({
      id: randomUUID(),
      userId: id,
      providerId: "credential",
      accountId: id,
      password: hash("the-old-password"),
    });
    const { team } = await service(billing(), id);
    const email = `maria-${randomUUID()}@shop.example`;
    const made_ = await team.setup({
      name: "Maria",
      email,
      password: "the-new-password",
    });
    expect(made_.userId).toBe(id);
    const [person] = await database
      .select()
      .from(users)
      .where(eq(users.id, id));
    expect(person?.email).toBe(email);
    const credentials = await database
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.userId, id), eq(accounts.providerId, "credential")),
      );
    expect(credentials.map((one) => one.password)).toEqual([
      hash("the-new-password"),
    ]);
  });

  test("a sub-profile is made with its employees, but cannot use ArkAgent until it is paid", async () => {
    const bill = billing(0);
    const { team } = await service(bill);
    const { adminId, agentIds } = await company(team);
    const made1 = await team.addSubprofile(
      adminId,
      staff(`n-${randomUUID()}@shop.example`, [agentIds[0] as string]),
    );
    expect(made1.checkoutUrl).toStartWith("https://checkout.stripe.com/");
    expect(bill.asked).toEqual([1]);
    // The board's view of the team: names, emails, roles, status, employees; no password.
    expect(bill.rosters[0]).toEqual([
      expect.objectContaining({
        name: "Maria",
        role: "admin",
        status: "active",
        agents: 3,
      }),
      expect.objectContaining({
        name: "Nikos",
        role: "subprofile",
        status: "pending_payment",
        agents: 1,
      }),
    ]);
    expect(JSON.stringify(bill.rosters[0])).not.toContain("password");
    expect(await team.mayUse(made1.userId)).toEqual({
      ok: false,
      reason:
        "This sub-profile is not active yet: your administrator's payment for it has not gone through.",
    });
    // Its role is a plain user, and it is in the administrator's account.
    const [role] = await database
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, made1.userId));
    expect(role?.role).toBe("user");
    const [membership] = await database
      .select()
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, made1.userId));
    expect(membership?.role).toBe("member");

    bill.setPaid(1);
    await team.syncBilling();
    expect(await team.mayUse(made1.userId)).toEqual({ ok: true });
    expect(await team.me(made1.userId)).toMatchObject({
      role: "subprofile",
      status: "active",
      mustChangePassword: true,
    });

    // A failed renewal: suspended and signed out.
    await database.insert(sessions).values({
      id: randomUUID(),
      userId: made1.userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    bill.setPaid(0);
    await team.syncBilling();
    expect((await team.mayUse(made1.userId)).ok).toBe(false);
    expect(
      await database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, made1.userId)),
    ).toEqual([]);
  });

  test("ONE employee, ONE sub-profile: a second is refused with who has it; confirmed, it moves", async () => {
    const { team } = await service(billing(5));
    const { adminId, agentIds } = await company(team);
    const [a, b] = agentIds as [string, string];
    const first = await team.addSubprofile(
      adminId,
      staff(`a-${randomUUID()}@shop.example`, [a]),
    );
    const refused = await team
      .addSubprofile(adminId, staff(`b-${randomUUID()}@shop.example`, [a, b]))
      .catch((error) => error);
    expect(refused.status).toBe(409);
    expect(refused.detail).toEqual({
      conflicts: [{ agentId: a, fromUserId: first.userId, fromName: "Nikos" }],
    });
    // Nothing half-made: the refused person does not exist.
    expect((await team.list(adminId)).length).toBe(2);

    const second = await team.addSubprofile(
      adminId,
      staff(`b-${randomUUID()}@shop.example`, [a, b], true),
    );
    const holders = await database.select().from(subprofileAgents);
    expect(
      holders.filter((row) => row.agentId === a).map((row) => row.userId),
    ).toEqual([second.userId]);
    expect(
      (await team.list(adminId)).find((m) => m.userId === first.userId)
        ?.agentIds,
    ).toEqual([]);
  });

  test("an employee given to a sub-profile is said to be, and leaves the administrator's browser", async () => {
    const { team, assigned } = await service(billing(5));
    const { adminId, agentIds } = await company(team);
    const [a, b] = agentIds as [string, string];
    expect(await team.isAssigned(a)).toBe(false);
    await team.addSubprofile(
      adminId,
      staff(`a-${randomUUID()}@shop.example`, [a]),
    );
    expect(await team.isAssigned(a)).toBe(true);
    expect(await team.isAssigned(b)).toBe(false);
    // Told once the assignment is kept, so the administrator's browser lets that employee go.
    expect(assigned).toEqual([[a]]);
  });

  test("two set-ups at the same moment make exactly one administrator, and leave nobody half-made", async () => {
    const { team } = await service();
    const tries = await Promise.allSettled(
      ["one", "two", "three"].map((who) =>
        team.setup({
          name: who,
          email: `${who}-${randomUUID()}@shop.example`,
          password: "first-password-1",
        }),
      ),
    );
    const made = tries.flatMap((one) =>
      one.status === "fulfilled" ? [one.value.userId] : [],
    );
    for (const id of made) madeUsers(id);
    expect(made).toHaveLength(1);
    for (const one of tries)
      if (one.status === "rejected")
        expect((one.reason as { status?: number }).status).toBe(409);
    const admins = await database
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.kind, "admin"));
    expect(admins.map((row) => row.userId)).toEqual(made);
  });

  test("two administrators giving the same employee at once: the database keeps exactly one", async () => {
    const { team } = await service(billing(5));
    const { adminId, agentIds } = await company(team);
    const one = await team.addSubprofile(
      adminId,
      staff(`c-${randomUUID()}@shop.example`, [agentIds[1] as string]),
    );
    const two = await team.addSubprofile(
      adminId,
      staff(`d-${randomUUID()}@shop.example`, [agentIds[2] as string]),
    );
    const target = agentIds[0] as string;
    const results = await Promise.allSettled([
      team.setAgents(adminId, one.userId, [target], false),
      team.setAgents(adminId, two.userId, [target], false),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rows = await database
      .select()
      .from(subprofileAgents)
      .where(eq(subprofileAgents.agentId, target));
    expect(rows.length).toBe(1);
  });

  test("a sub-profile sees exactly its employees; the administrator sees them all", async () => {
    const { team } = await service(billing(5));
    const { adminId, agentIds } = await company(team);
    const sub = await team.addSubprofile(
      adminId,
      staff(`e-${randomUUID()}@shop.example`, [agentIds[1] as string]),
    );
    const visible = async (actor: { id: string; role: "admin" | "user" }) =>
      (
        await database
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .where(
            and(
              inArray(agentProfiles.agentId, agentIds),
              visibleAgentProfiles(database, actor),
            ),
          )
      ).map((row) => row.id);
    expect(await visible({ id: sub.userId, role: "user" })).toEqual([
      agentIds[1] as string,
    ]);
    expect((await visible({ id: adminId, role: "admin" })).sort()).toEqual(
      [...agentIds].sort(),
    );
    // Changed by the administrator: applies on the next request.
    await team.setAgents(adminId, sub.userId, [agentIds[2] as string], false);
    expect(await visible({ id: sub.userId, role: "user" })).toEqual([
      agentIds[2] as string,
    ]);
  });

  test("sub-profiles manage nobody; removing one signs it out, frees its employees, and lowers the number paid", async () => {
    const bill = billing(5);
    const { team } = await service(bill);
    const { adminId, agentIds } = await company(team);
    const sub = await team.addSubprofile(
      adminId,
      staff(`f-${randomUUID()}@shop.example`, [agentIds[0] as string]),
    );
    for (const attempt of [
      () => team.list(sub.userId),
      () =>
        team.addSubprofile(
          sub.userId,
          staff(`g-${randomUUID()}@shop.example`, [agentIds[1] as string]),
        ),
      () => team.remove(sub.userId, adminId),
    ])
      await expect(attempt()).rejects.toThrow(
        "Only the administrator can do this.",
      );
    await team.remove(adminId, sub.userId);
    expect(bill.asked.at(-1)).toBe(0);
    expect((await team.mayUse(sub.userId)).ok).toBe(false);
    expect(await database.select().from(subprofileAgents)).toEqual([]);
  });

  test("the first sign-in's password change checks the initial one", async () => {
    const { team } = await service(billing(5));
    const { adminId, agentIds } = await company(team);
    const sub = await team.addSubprofile(
      adminId,
      staff(`h-${randomUUID()}@shop.example`, [agentIds[0] as string]),
    );
    await expect(
      team.changePassword(sub.userId, "wrong", "my-own-password-1"),
    ).rejects.toThrow("The current password is not right.");
    await team.changePassword(
      sub.userId,
      "initial-password-1",
      "my-own-password-1",
    );
    expect((await team.me(sub.userId)).mustChangePassword).toBe(false);
  });

  test("a sub-profile must be given at least one employee, and only the company's", async () => {
    const { team } = await service(billing(5));
    const { adminId } = await company(team);
    await expect(
      team.addSubprofile(adminId, staff(`i-${randomUUID()}@shop.example`, [])),
    ).rejects.toThrow("Choose at least one digital employee");
    await expect(
      team.addSubprofile(
        adminId,
        staff(`j-${randomUUID()}@shop.example`, ["agent-not-ours"]),
      ),
    ).rejects.toThrow("not the company's");
  });
});
