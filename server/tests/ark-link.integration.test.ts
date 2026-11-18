/**
 * Settings → Phones on the server (#149), with the test database: the `/api/ark-link` routes, the
 * service behind them, the real relay from `infra/ark-link`, and a small local server playing this
 * install's app. Nothing leaves the machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createLinkRelay } from "../../infra/ark-link/relay";
import { newInstallToken, tokenHash } from "../../shared/ark-link";
import { createArkLinkRoutes } from "../src/ark-link/routes";
import { createArkLinkService, NEEDS_SIGN_IN } from "../src/ark-link/service";
import type { AuditEventInput } from "../src/audit";
import { type AppVariables, createRoleRepository } from "../src/auth/guards";
import { setRole } from "../src/auth/roles";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  arkLink,
  arkLinkDevices,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const adminId = `ark-link-${randomUUID()}`;
const installToken = newInstallToken();
const installHash = await tokenHash(installToken);
const events: AuditEventInput[] = [];

const relay = createLinkRelay({
  linkOrigin: "https://link.example",
  installs: () => [{ id: "demo-shop", tokenSha256: installHash }],
  log: () => undefined,
});
const relayServer = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
const relayBase = `http://localhost:${relayServer.port}`;

const localApp = Bun.serve({
  port: 0,
  fetch: (request) =>
    new Response(`this install's app: ${new URL(request.url).pathname}`),
});

/** Who is still here, read from the database the way the server reads it. No caching in tests. */
const roleRepository = createRoleRepository(database);
const people = {
  isRevoked: async (email: string) =>
    (
      await database
        .select()
        .from(revokedAccess)
        .where(eq(revokedAccess.email, email))
    ).length > 0,
  rolesFor: (userId: string) => roleRepository.rolesForUser(userId),
  personCheckMs: 0,
};
const colleagueId = `ark-link-colleague-${randomUUID()}`;

const service = createArkLinkService(database, {
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 9).toString("base64"),
  auditStore: { insert: async (event) => void events.push(event) },
  localOrigin: `http://127.0.0.1:${localApp.port}`,
  noSignIn: false,
  allowInsecureRelay: true,
  skipLock: true,
  ...people,
});
service.start();

/** The app's routes over `arkLink`, signed in as the `x-role` header says, or not at all. */
function appFor(arkLink: typeof service) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.route(
    "/api/ark-link",
    createArkLinkRoutes({
      arkLink,
      requireUser: async (context, next) => {
        const role = context.req.header("x-role");
        if (role === "anonymous")
          return context.json({ error: "Sign in first." }, 401);
        context.set("actor", {
          id: context.req.header("x-as") ?? adminId,
          role: role === "member" ? "member" : "admin",
        } as AppVariables["actor"]);
        await next();
      },
    }),
  );
  return routes;
}
const app = appFor(service);

const call = (
  method: string,
  path: string,
  body?: unknown,
  role = "admin",
  on = app,
  as?: string,
) =>
  on.request(`/api/ark-link${path === "/" ? "" : path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-role": role,
      ...(as ? { "x-as": as } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const until = async (check: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !(await check())) await Bun.sleep(15);
  expect(await check()).toBe(true);
};

const post = (path: string, body: unknown) =>
  fetch(`${relayBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

await database.insert(users).values([
  { id: adminId, email: `${adminId}@example.test`, name: "Admin" },
  { id: colleagueId, email: `${colleagueId}@example.test`, name: "Colleague" },
]);
await setRole(database, adminId, "admin");
await setRole(database, colleagueId, "user");

afterAll(async () => {
  await service.stop();
  relay.stop();
  void relayServer.stop(true);
  void localApp.stop(true);
  await database.delete(arkLinkDevices);
  await database.delete(arkLink);
  await database
    .delete(revokedAccess)
    .where(eq(revokedAccess.email, `${colleagueId}@example.test`));
  await database
    .delete(userRoles)
    .where(inArray(userRoles.userId, [adminId, colleagueId]));
  await database.delete(users).where(inArray(users.id, [adminId, colleagueId]));
  await database.$client.close();
});

let deviceToken = "";
let deviceId = "";

describe("Settings → Phones (#149)", () => {
  test("only an administrator sees or changes it", async () => {
    expect((await call("GET", "/", undefined, "member")).status).toBe(403);
    expect(
      (
        await call(
          "PUT",
          "/",
          { relayUrl: relayBase, installToken, enabled: true },
          "member",
        )
      ).status,
    ).toBe(403);
  });

  test("it is off until an administrator switches it on", async () => {
    await database.delete(arkLinkDevices);
    await database.delete(arkLink);
    const view = await (await call("GET", "/")).json();
    expect(view).toMatchObject({
      configured: false,
      enabled: false,
      status: "off",
      devices: [],
      noSignIn: false,
    });
    expect(relay.connected).toEqual([]);
  });

  test("a wrong relay address or install token is refused with a sentence", async () => {
    const insecure = await call("PUT", "/", {
      relayUrl: "ftp://link.example",
      installToken,
      enabled: true,
    });
    expect(insecure.status).toBe(400);
    const token = await call("PUT", "/", {
      relayUrl: relayBase,
      installToken: "not-a-token",
      enabled: true,
    });
    expect(token.status).toBe(400);
    expect((await token.json()).error).toContain("arki_");
  });

  test("switched on, it connects to the relay, and the token is never sent back", async () => {
    const saved = await call("PUT", "/", {
      relayUrl: relayBase,
      installToken,
      enabled: true,
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(installToken);
    await until(async () => {
      const view = await (await call("GET", "/")).json();
      return view.status === "connected";
    });
    expect(relay.connected).toEqual(["demo-shop"]);
    const [row] = await database.select().from(arkLink);
    expect(JSON.stringify(row)).not.toContain(installToken);
  });

  test("an administrator pairs a phone: a code, the phone claims it, a person confirms the name", async () => {
    const started = await call("POST", "/pairing");
    const pairing = await started.json();
    expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(pairing.display).toBe(
      `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`,
    );
    expect(pairing.url).toBe(`${relayBase}/_link/pair?code=${pairing.code}`);

    const claim = await (
      await post("/_link/pair/claim", {
        code: pairing.display.toLowerCase(),
        deviceName: "Pixel",
      })
    ).json();
    expect(claim.status).toBe("pending");
    await until(async () => {
      const view = await (await call("GET", "/")).json();
      return view.pairing?.claims?.[0]?.deviceName === "Pixel";
    });

    // Not yet: the phone waits for the person at the desktop.
    expect(
      (
        await (
          await post("/_link/pair/status", { pairingId: claim.pairingId })
        ).json()
      ).status,
    ).toBe("pending");

    // Only a signed-in administrator confirms (Amgad, 18 Nov): not a member, not nobody.
    for (const [role, status] of [
      ["member", 403],
      ["anonymous", 401],
    ] as const)
      expect(
        (
          await call(
            "POST",
            `/pairing/${claim.pairingId}/confirm`,
            { deviceName: "Intruder" },
            role,
          )
        ).status,
      ).toBe(status);

    const confirmed = await call(
      "POST",
      `/pairing/${claim.pairingId}/confirm`,
      { deviceName: "Μαρία's Pixel" },
    );
    expect(confirmed.status).toBe(200);
    const device = await confirmed.json();
    expect(device.name).toBe("Μαρία's Pixel");
    deviceId = device.id;

    const answer = await (
      await post("/_link/pair/status", { pairingId: claim.pairingId })
    ).json();
    expect(answer.status).toBe("confirmed");
    deviceToken = answer.deviceToken;

    // Stored as a hash, never as the token.
    const [row] = await database
      .select()
      .from(arkLinkDevices)
      .where(eq(arkLinkDevices.id, deviceId));
    expect(row?.tokenSha256).toBe(await tokenHash(deviceToken));
    expect(JSON.stringify(row)).not.toContain(deviceToken);
    expect(JSON.stringify(events)).not.toContain(deviceToken);
    expect(events.map((event) => event.eventType)).toContain(
      "ark_link.device_paired",
    );

    // The code was spent: the screen no longer shows it.
    const view = await (await call("GET", "/")).json();
    expect(view.pairing).toBeNull();
  });

  test("the paired phone reaches this install's app, and its last use is shown", async () => {
    const response = await fetch(`${relayBase}/approvals`, {
      headers: { cookie: `ark_link=${deviceToken}` },
    });
    expect(await response.text()).toBe("this install's app: /approvals");
    await until(async () => {
      const view = await (await call("GET", "/")).json();
      return view.devices[0]?.lastUsedAt !== null;
    });
    const view = await (await call("GET", "/")).json();
    expect(view.devices).toHaveLength(1);
    expect(view.devices[0].name).toBe("Μαρία's Pixel");
  });

  test("a phone the person declines gets nothing", async () => {
    const pairing = await (await call("POST", "/pairing")).json();
    const claim = await (
      await post("/_link/pair/claim", {
        code: pairing.code,
        deviceName: "Unknown phone",
      })
    ).json();
    await until(async () => {
      const view = await (await call("GET", "/")).json();
      return view.pairing?.claims?.length === 1;
    });
    expect(
      (await call("POST", `/pairing/${claim.pairingId}/refuse`)).status,
    ).toBe(204);
    await until(
      async () =>
        (
          await (
            await post("/_link/pair/status", { pairingId: claim.pairingId })
          ).json()
        ).status !== "pending",
    );
    expect((await (await call("GET", "/")).json()).devices).toHaveLength(1);
  });

  test("a phone paired for another person waits for them to accept it, on their own computer", async () => {
    const pairing = await (await call("POST", "/pairing")).json();
    const claim = await (
      await post("/_link/pair/claim", {
        code: pairing.code,
        deviceName: "Colleague's phone",
      })
    ).json();
    await until(async () => {
      const view = await (await call("GET", "/")).json();
      return view.pairing?.claims?.length === 1;
    });
    // Nobody who is not a member here can have one.
    expect(
      (
        await call("POST", `/pairing/${claim.pairingId}/confirm`, {
          deviceName: "Ghost's phone",
          forUserId: "nobody-here",
        })
      ).status,
    ).toBe(409);
    const confirmed = await call(
      "POST",
      `/pairing/${claim.pairingId}/confirm`,
      {
        deviceName: "Colleague's phone",
        forUserId: colleagueId,
      },
    );
    expect(confirmed.status).toBe(200);
    const device = await confirmed.json();
    expect(device.pending).toBe(true);
    expect(device.person.id).toBe(colleagueId);
    const token = (
      await (
        await post("/_link/pair/status", { pairingId: claim.pairingId })
      ).json()
    ).deviceToken;

    // Until accepted, the phone reaches nothing, and says why.
    const waiting = await fetch(`${relayBase}/api/me`, {
      headers: { authorization: `ArkLink ${token}` },
    });
    expect(waiting.status).toBe(403);
    expect((await waiting.json()).code).toBe("ark_link_pending");

    // The colleague sees it among their own; the administrator cannot accept it for them.
    const mine = await (
      await call("GET", "/mine", undefined, "member", app, colleagueId)
    ).json();
    expect(mine.devices.map((d: { id: string }) => d.id)).toEqual([device.id]);
    expect((await call("POST", `/devices/${device.id}/accept`)).status).toBe(
      404,
    );
    expect(
      (
        await call(
          "POST",
          `/devices/${device.id}/accept`,
          undefined,
          "member",
          app,
          colleagueId,
        )
      ).status,
    ).toBe(204);
    const works = await fetch(`${relayBase}/settings`, {
      headers: { authorization: `ArkLink ${token}` },
    });
    expect(await works.text()).toBe("this install's app: /settings");
    expect(events.map((event) => event.eventType)).toContain(
      "ark_link.device_accepted",
    );

    // A person removed, or left with no role, is cut off on the phone at once.
    await database.delete(userRoles).where(eq(userRoles.userId, colleagueId));
    expect(
      (
        await fetch(`${relayBase}/x`, {
          headers: { authorization: `ArkLink ${token}` },
        })
      ).status,
    ).toBe(401);
    await setRole(database, colleagueId, "user");
    await database.insert(revokedAccess).values({
      email: `${colleagueId}@example.test`,
      revokedBy: adminId,
    });
    expect(
      (
        await fetch(`${relayBase}/x`, {
          headers: { authorization: `ArkLink ${token}` },
        })
      ).status,
    ).toBe(401);
    // And nobody but an administrator removes a phone that is not theirs.
    expect(
      (
        await call(
          "DELETE",
          `/devices/${deviceId}`,
          undefined,
          "member",
          app,
          colleagueId,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "DELETE",
          `/devices/${device.id}`,
          undefined,
          "member",
          app,
          colleagueId,
        )
      ).status,
    ).toBe(204);
  });

  test("removing a phone cuts it immediately", async () => {
    expect((await call("DELETE", `/devices/${deviceId}`)).status).toBe(204);
    const refused = await fetch(`${relayBase}/api/me`, {
      headers: { authorization: `ArkLink ${deviceToken}` },
    });
    expect(refused.status).toBe(401);
    expect((await (await call("GET", "/")).json()).devices).toEqual([]);
    expect((await call("DELETE", `/devices/${deviceId}`)).status).toBe(404);
  });

  test("switched off, it disconnects, and pairing is refused", async () => {
    const saved = await call("PUT", "/", {
      relayUrl: relayBase,
      enabled: false,
    });
    expect(saved.status).toBe(200);
    await until(() => relay.connected.length === 0);
    expect((await call("POST", "/pairing")).status).toBe(409);
  });
});

describe("an install with no sign-in (Amgad, 18 Nov: option b)", () => {
  const noSignIn = createArkLinkService(database, {
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 9).toString("base64"),
    auditStore: { insert: async (event) => void events.push(event) },
    localOrigin: `http://127.0.0.1:${localApp.port}`,
    noSignIn: true,
    allowInsecureRelay: true,
    skipLock: true,
    ...people,
  });
  const single = appFor(noSignIn);
  afterAll(() => noSignIn.stop());

  test("cannot switch phone access on, and says sign-in comes first", async () => {
    const saved = await call(
      "PUT",
      "/",
      { relayUrl: relayBase, installToken, enabled: true },
      "admin",
      single,
    );
    expect(saved.status).toBe(400);
    expect((await saved.json()).error).toBe(NEEDS_SIGN_IN);
    const view = await (
      await call("GET", "/", undefined, "admin", single)
    ).json();
    expect(view.noSignIn).toBe(true);
    expect(view.status).toBe("off");
  });

  test("cannot start or confirm a pairing", async () => {
    const started = await call("POST", "/pairing", undefined, "admin", single);
    expect(started.status).toBe(409);
    expect((await started.json()).error).toBe(NEEDS_SIGN_IN);
    const confirmed = await call(
      "POST",
      "/pairing/someone/confirm",
      { deviceName: "Phone" },
      "admin",
      single,
    );
    expect(confirmed.status).toBe(409);
  });

  test("never connects to the relay, even with Ark Link saved as on", async () => {
    await service.save(adminId, {
      relayUrl: relayBase,
      installToken,
      enabled: true,
    });
    await until(() => relay.connected.length === 1);
    await service.stop();
    await until(() => relay.connected.length === 0);
    noSignIn.start();
    await Bun.sleep(300);
    expect(relay.connected).toEqual([]);
  });
});
