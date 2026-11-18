/**
 * A paired phone acts as its person (#149, PE 18 Nov), with the test database and the real app.
 *
 * What is held: a request the connector made for a phone is that device's person, with the role they
 * hold right now (so a demotion applies on the next request) and nothing else; a removed device, a
 * device still waiting for its person, and a removed person are nobody; a phone cannot name its own
 * person, by header or by a cookie it carries; sign-in is never offered to a phone; and an audit row
 * written for a phone's request says so, with the device.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createApp } from "../src/app";
import {
  arkLinkRequestContext,
  markLinkRequest,
  SIGN_IN_ON_COMPUTER,
} from "../src/ark-link/marker";
import {
  linkPersonResolver,
  withArkLinkSessions,
} from "../src/ark-link/sessions";
import { type AuditEventInput, recordAuditEvent } from "../src/audit";
import {
  type AppVariables,
  type AuthService,
  createRequireUser,
  createRoleRepository,
  requireAdmin,
} from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  arkLinkDevices,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const run = randomUUID().slice(0, 8);
const admin = {
  id: `alp-admin-${run}`,
  email: `alp-admin-${run}@example.test`,
};
const member = {
  id: `alp-member-${run}`,
  email: `alp-member-${run}@example.test`,
};
const other = {
  id: `alp-other-${run}`,
  email: `alp-other-${run}@example.test`,
};
const adminPhone = randomUUID();
const memberPhone = randomUUID();
const waitingPhone = randomUUID();

/** A sign-in that would answer `other` to any cookie: the cookie a phone carries must not count. */
const cookieSignIn: AuthService = {
  handler: () => new Response("signed in", { status: 200 }),
  api: {
    getSession: async ({ headers }) =>
      headers.get("cookie")
        ? { user: { id: other.id, email: other.email, name: "Other" } }
        : null,
  },
};
const roles = createRoleRepository(database);
const isRevoked = async (email: string) =>
  (
    await database
      .select()
      .from(revokedAccess)
      .where(eq(revokedAccess.email, email))
  ).length > 0;
const auth = withArkLinkSessions(
  cookieSignIn,
  linkPersonResolver(database, isRevoked),
);
const app = createApp(loadConfig(testEnvironment()), auth, roles);

/** As the connector sends it for `deviceId`, with whatever the phone itself added. */
const fromPhone = (
  deviceId: string,
  phoneHeaders: Record<string, string> = {},
) => markLinkRequest(new Headers(phoneHeaders), deviceId);

const me = async (headers: Headers) => {
  const response = await app.request("http://localhost/api/me", { headers });
  return {
    status: response.status,
    user: response.ok
      ? ((await response.json()) as { user: { id: string; role: string } }).user
      : null,
  };
};

await database.insert(users).values([
  { ...admin, name: "Admin" },
  { ...member, name: "Member" },
  { ...other, name: "Other" },
]);
await setRole(database, admin.id, "admin");
await setRole(database, member.id, "user");
await setRole(database, other.id, "admin");
const device = (id: string, userId: string, accepted: boolean) => ({
  id,
  name: `phone-${id.slice(0, 4)}`,
  tokenSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
  userId,
  pairedBy: admin.id,
  acceptedAt: accepted ? new Date() : null,
});
await database
  .insert(arkLinkDevices)
  .values([
    device(adminPhone, admin.id, true),
    device(memberPhone, member.id, true),
    device(waitingPhone, member.id, false),
  ]);

afterAll(async () => {
  await database
    .delete(arkLinkDevices)
    .where(inArray(arkLinkDevices.id, [adminPhone, memberPhone, waitingPhone]));
  await database
    .delete(revokedAccess)
    .where(inArray(revokedAccess.email, [admin.email, member.email]));
  await database
    .delete(userRoles)
    .where(inArray(userRoles.userId, [admin.id, member.id, other.id]));
  await database
    .delete(users)
    .where(inArray(users.id, [admin.id, member.id, other.id]));
  await database.$client.close();
});

describe("a paired phone acts as its person", () => {
  test("it is the person it was paired for, with their role, whatever cookie it carries", async () => {
    const answer = await me(
      fromPhone(memberPhone, { cookie: "better-auth.session_token=other" }),
    );
    expect(answer.status).toBe(200);
    expect(answer.user?.id).toBe(member.id);
    expect(answer.user?.role).toBe("user");
    // Off the link, the same cookie is the cookie's person, as before.
    const browser = await me(
      new Headers({ cookie: "better-auth.session_token=other" }),
    );
    expect(browser.user?.id).toBe(other.id);
  });

  test("a phone cannot name its person: a header naming one is taken off, a forged mark is not the link", async () => {
    const named = await me(
      fromPhone(memberPhone, {
        "x-user-id": other.id,
        "x-openbot-user": other.email,
        "x-ark-link-device": adminPhone,
      }),
    );
    expect(named.user?.id).toBe(member.id);
    // Without the connector's secret, naming a device is just a header, and the cookie decides.
    const forged = await me(
      new Headers({
        "x-ark-link-proof": "guess",
        "x-ark-link-device": adminPhone,
        cookie: "better-auth.session_token=other",
      }),
    );
    expect(forged.user?.id).toBe(other.id);
  });

  test("the person's boundaries apply: a member's phone is refused what only an administrator may do", async () => {
    const guarded = new Hono<{ Variables: AppVariables }>();
    guarded.get("/admin-only", createRequireUser(auth, roles), (context) => {
      const denied = requireAdmin(context);
      return denied ?? context.json({ ok: true });
    });
    expect(
      (
        await guarded.request("/admin-only", {
          headers: fromPhone(memberPhone),
        })
      ).status,
    ).toBe(403);
    expect(
      (await guarded.request("/admin-only", { headers: fromPhone(adminPhone) }))
        .status,
    ).toBe(200);
  });

  test("a person demoted is the lower role on the phone's next request", async () => {
    expect((await me(fromPhone(adminPhone))).user?.role).toBe("admin");
    await setRole(database, admin.id, "user");
    expect((await me(fromPhone(adminPhone))).user?.role).toBe("user");
    await setRole(database, admin.id, "admin");
  });

  test("a phone still waiting for its person to accept it is nobody", async () => {
    expect((await me(fromPhone(waitingPhone))).status).toBe(401);
  });

  test("a person removed by an administrator is nobody on their phone at once", async () => {
    await database
      .insert(revokedAccess)
      .values({ email: member.email, revokedBy: admin.id });
    expect((await me(fromPhone(memberPhone))).status).toBe(401);
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, member.email));
    expect((await me(fromPhone(memberPhone))).status).toBe(200);
  });

  test("a removed device is nobody", async () => {
    await database
      .delete(arkLinkDevices)
      .where(eq(arkLinkDevices.id, memberPhone));
    expect((await me(fromPhone(memberPhone))).status).toBe(401);
  });

  test("a phone is never offered a sign-in: the sign-in calls and page answer to sign in on the computer", async () => {
    const social = await app.request(
      "http://localhost/api/auth/sign-in/social",
      { method: "POST", headers: fromPhone(adminPhone) },
    );
    expect(social.status).toBe(409);
    expect(await social.json()).toEqual({
      error: SIGN_IN_ON_COMPUTER,
      code: "sign_in_on_computer",
    });
    const page = await app.request("http://localhost/sign", {
      headers: fromPhone(adminPhone),
      redirect: "manual",
    });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/");
    // At the computer, sign-in is what it was.
    const computer = await app.request(
      "http://localhost/api/auth/sign-in/social",
      { method: "POST" },
    );
    expect(computer.status).not.toBe(409);
  });

  test("an audit row written for a phone's request says it came through Ark Link, and from which phone", async () => {
    const rows: AuditEventInput[] = [];
    const store = {
      insert: async (row: AuditEventInput) => void rows.push(row),
    };
    const audited = new Hono();
    audited.use("*", arkLinkRequestContext);
    audited.post("/act", async (context) => {
      await recordAuditEvent(store, {
        eventType: "memory.added",
        targetType: "memory",
        actorUserId: admin.id,
        payload: { note: "x" },
      });
      return context.body(null, 204);
    });
    await audited.request("/act", {
      method: "POST",
      headers: fromPhone(adminPhone),
    });
    await audited.request("/act", { method: "POST" });
    expect(rows[0]?.payload).toEqual({ note: "x", arkLinkDevice: adminPhone });
    expect(rows[1]?.payload).toEqual({ note: "x" });
  });
});
