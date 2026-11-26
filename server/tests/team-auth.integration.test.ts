import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createTeamService, type TeamAuthContext } from "../src/accounts/team";
import { createAuth } from "../src/auth";
import {
  jsonSignInOnly,
  revokeOtherSessionsOnPasswordChange,
} from "../src/auth/attempts";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  sessions,
  subprofileAgents,
  teamMembers,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Signing in as yourself, with the real sign-in library (Amgad, 24 Nov 2026): the desktop runs password
 * sign-in only, so the administrator made at set-up, and a sub-profile, must get in through it. The
 * other team tests stand in for the library; this one does not.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const config = loadConfig(
  testEnvironment({
    DATABASE_URL: testDatabaseUrl(),
    GOOGLE_OAUTH_CLIENT_ID: undefined,
    GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    INITIAL_ADMIN_EMAILS: "",
    OPENBOT_PASSWORD_SIGNIN: "true",
    TRUSTED_ORIGINS: "http://localhost:52110",
  }),
);
const auth = createAuth(
  config,
  database,
  undefined,
  undefined,
  // As the server wires it: a sub-profile that may not use the deployment gets no session.
  (userId) => team.mayUse(userId),
);
let soleUser: string | null = null;
const team = createTeamService({
  database,
  soleUser: async () => soleUser,
  authContext: async () =>
    (await (auth as unknown as { $context: Promise<TeamAuthContext> })
      .$context) as TeamAuthContext,
});
const emails: string[] = [];

async function clearTeam() {
  await database.delete(subprofileAgents);
  await database.delete(teamMembers);
}
beforeEach(clearTeam);
afterAll(async () => {
  await clearTeam();
  const made = emails.length
    ? await database
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.email, emails))
    : [];
  const ids = made.map((one) => one.id);
  if (ids.length) {
    await database.delete(sessions).where(inArray(sessions.userId, ids));
    await database.delete(accounts).where(inArray(accounts.userId, ids));
    await database.delete(users).where(inArray(users.id, ids));
  }
  await database.$client.close();
});

const email = () => {
  const one = `team-${randomUUID()}@example.test`;
  emails.push(one);
  return one;
};

function signIn(address: string, password: string) {
  return auth.handler(
    new Request("http://localhost:3001/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:52110",
      },
      body: JSON.stringify({ email: address, password }),
    }),
  );
}

test("the administrator made at set-up signs in with that email and password, and nobody else does", async () => {
  expect(config.auth?.passwordSignIn).toBe(true);
  const admin = email();
  expect(await team.setupNeeded()).toBe(true);
  await team.setup({
    name: "Maria",
    email: admin,
    password: "a-long-password",
  });
  expect(await team.setupNeeded()).toBe(false);

  const ok = await signIn(admin, "a-long-password");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("set-cookie") ?? "").toContain("session_token");
  expect((await signIn(admin, "the-wrong-one")).status).toBe(401);

  // Nobody makes their own account: sign-up is off.
  const signUp = await auth.handler(
    new Request("http://localhost:3001/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:52110",
      },
      body: JSON.stringify({
        name: "Stranger",
        email: email(),
        password: "a-long-password",
      }),
    }),
  );
  expect(signUp.status).toBeGreaterThanOrEqual(400);
});

test("a sub-profile's first password works with the real library, and the new one replaces it", async () => {
  const admin = email();
  const { userId: adminId } = await team.setup({
    name: "Maria",
    email: admin,
    password: "a-long-password",
  });
  // Made the way addSubprofile makes one, without billing or employees.
  const context = await (
    auth as unknown as { $context: Promise<TeamAuthContext> }
  ).$context;
  const staff = email();
  const { id } = await context.internalAdapter.createUser({
    name: "Nikos",
    email: staff,
    emailVerified: true,
  });
  await context.internalAdapter.linkAccount({
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await context.password.hash("first-password-1"),
  });
  await database.insert(teamMembers).values({
    userId: id,
    kind: "subprofile",
    status: "active",
    mustChangePassword: true,
    createdBy: adminId,
  });
  expect((await signIn(staff, "first-password-1")).status).toBe(200);
  await team.changePassword(id, "first-password-1", "my-own-password");
  expect((await signIn(staff, "first-password-1")).status).toBe(401);
  expect((await signIn(staff, "my-own-password")).status).toBe(200);
  const [row] = await database
    .select({ must: teamMembers.mustChangePassword })
    .from(teamMembers)
    .where(eq(teamMembers.userId, id));
  expect(row?.must).toBe(false);
});

test("an install's one person becomes the administrator, signing in with the new password only", async () => {
  const context = await (
    auth as unknown as { $context: Promise<TeamAuthContext> }
  ).$context;
  const before = email();
  const { id } = await context.internalAdapter.createUser({
    name: "dev",
    email: before,
    emailVerified: false,
  });
  await context.internalAdapter.linkAccount({
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await context.password.hash("an-older-password"),
  });
  soleUser = id;
  try {
    const admin = email();
    const { userId } = await team.setup({
      name: "Maria",
      email: admin,
      password: "a-long-password",
    });
    expect(userId).toBe(id);
    expect((await signIn(admin, "a-long-password")).status).toBe(200);
    expect((await signIn(admin, "an-older-password")).status).toBe(401);
  } finally {
    soleUser = null;
  }
});

test("a sub-profile waiting for payment or suspended gets no session; removed, its password is gone", async () => {
  const { userId: adminId } = await team.setup({
    name: "Maria",
    email: email(),
    password: "a-long-password",
  });
  const context = await (
    auth as unknown as { $context: Promise<TeamAuthContext> }
  ).$context;
  const staff = email();
  const { id } = await context.internalAdapter.createUser({
    name: "Nikos",
    email: staff,
    emailVerified: true,
  });
  await context.internalAdapter.linkAccount({
    userId: id,
    providerId: "credential",
    accountId: id,
    password: await context.password.hash("first-password-1"),
  });
  await database.insert(teamMembers).values({
    userId: id,
    kind: "subprofile",
    status: "pending_payment",
    createdBy: adminId,
  });
  // The right password, and still no session: not paid yet.
  const pending = await signIn(staff, "first-password-1");
  expect(pending.status).toBe(403);
  expect(pending.headers.get("set-cookie") ?? "").not.toContain(
    "session_token=",
  );

  await database
    .update(teamMembers)
    .set({ status: "suspended" })
    .where(eq(teamMembers.userId, id));
  expect((await signIn(staff, "first-password-1")).status).toBe(403);

  await database
    .update(teamMembers)
    .set({ status: "active" })
    .where(eq(teamMembers.userId, id));
  expect((await signIn(staff, "first-password-1")).status).toBe(200);

  await team.remove(adminId, id);
  // Removed: the password no longer works at all.
  expect((await signIn(staff, "first-password-1")).status).toBe(401);
});

test("a password change through Better Auth's own route signs out every other session (v0.1.57)", async () => {
  const admin = email();
  await team.setup({
    name: "Maria",
    email: admin,
    password: "a-long-password",
  });
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .filter((pair) => pair?.includes("session_token"))
      .join("; ");
  const here = cookieOf(await signIn(admin, "a-long-password"));
  const elsewhere = cookieOf(await signIn(admin, "a-long-password"));
  expect(here).not.toBe("");
  expect(elsewhere).not.toBe("");
  // As the server mounts it: the middleware, then Better Auth.
  const app = new Hono();
  app.use("/api/auth/change-password", revokeOtherSessionsOnPasswordChange());
  app.on(["GET", "POST"], "/api/auth/*", (context) =>
    auth.handler(context.req.raw),
  );
  const changed = await app.request(
    "http://localhost:3001/api/auth/change-password",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:52110",
        cookie: here,
      },
      body: JSON.stringify({
        currentPassword: "a-long-password",
        newPassword: "another-long-password",
        revokeOtherSessions: false,
      }),
    },
  );
  expect(changed.status).toBe(200);
  const session = (cookie: string) =>
    auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(await session(elsewhere)).toBeNull();
  expect((await signIn(admin, "another-long-password")).status).toBe(200);
});

test("a sign-in disguised as JSON and a form at once is refused before the library reads it (v0.1.57, F-A)", async () => {
  const admin = email();
  await team.setup({
    name: "Maria",
    email: admin,
    password: "a-long-password",
  });
  const app = new Hono();
  app.use("/api/auth/sign-in/email", jsonSignInOnly());
  app.on(["GET", "POST"], "/api/auth/*", (context) =>
    auth.handler(context.req.raw),
  );
  const send = (type: string, body: string) =>
    app.request("http://localhost:3001/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": type, origin: "http://localhost:52110" },
      body,
    });
  // The reviewer's request: valid JSON naming somebody else, a form naming the administrator.
  const disguised = JSON.stringify({
    email: "nobody@example.test",
    x: `&email=${encodeURIComponent(admin)}&password=a-long-password`,
  });
  for (const type of [
    "application/x-www-form-urlencoded, application/json",
    "application/x-www-form-urlencoded; x=/json",
    "multipart/form-data; boundary=x, application/json",
    "text/plain+json",
  ])
    expect((await send(type, disguised)).status).toBe(415);
  // The app's own request still signs in, with or without a charset.
  const own = JSON.stringify({ email: admin, password: "a-long-password" });
  expect((await send("application/json", own)).status).toBe(200);
  expect((await send("application/json; charset=utf-8", own)).status).toBe(200);
});
