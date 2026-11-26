import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { isLoopbackPeer, peerAllowed } from "../../shared/local-hosts";
import { teamAuditEvent } from "../src/accounts/team-audit";
import type { TeamService } from "../src/accounts/team";
import { sessionToken, teamSetupRoutes } from "../src/accounts/team-routes";
import { attemptGuard, createAttemptLimiter } from "../src/auth/attempts";
import { isPrivateAddress } from "../src/models/routes";
import { joinTokenUser, RECHECK_MS } from "../src/office/hub-socket";
import { officeServeOptions } from "../src/office/listener";

/**
 * The follow-ups from the security reviews of v0.1.54 and v0.1.55 that ship in v0.1.56 and need no
 * database: who a desktop server listening everywhere answers, the hub socket's person, set-up
 * without a secret, the limiter's edges, model addresses for staff and the audit trail's events.
 */
describe("a desktop server that had to listen on every interface (R5)", () => {
  test("answers this computer, and only the containers' own paths to anybody else", () => {
    for (const here of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])
      expect(isLoopbackPeer(here)).toBe(true);
    for (const there of ["192.168.1.30", "10.0.0.5", "172.17.0.2", "", null])
      expect(isLoopbackPeer(there)).toBe(false);
    expect(peerAllowed("172.17.0.2", "/api/agent-tools/call")).toBe(true);
    expect(
      peerAllowed("172.17.0.2", "/api/model-provider/v1/chat/completions"),
    ).toBe(true);
    expect(peerAllowed("192.168.1.30", "/health")).toBe(true);
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/team/setup",
      "/api/copilotkit",
      "/",
      "/health/x",
      "/api/agent-toolsX",
    ])
      expect(peerAllowed("192.168.1.30", path)).toBe(false);
    expect(peerAllowed("127.0.0.1", "/api/auth/sign-in/email")).toBe(true);
  });
});

describe("the conversation hub's socket over the office network (R4)", () => {
  const token = (userId: unknown) =>
    `${Buffer.from(JSON.stringify({ s: { kind: "meta", userId }, exp: 9e9 })).toString("base64url")}.sig`;

  test("the person is read from the join token, and nothing else is a person", () => {
    expect(joinTokenUser(`?join_token=${token("u-1")}`)).toBe("u-1");
    expect(joinTokenUser("?join_token=garbage")).toBeNull();
    expect(joinTokenUser(`?join_token=${token(42)}`)).toBeNull();
    expect(joinTokenUser("")).toBeNull();
    expect(RECHECK_MS).toBeLessThanOrEqual(10_000);
  });

  test("a person who may no longer use ArkAgent gets no socket; one without a token neither", async () => {
    const options = officeServeOptions(
      {
        fetch: () => new Response("app"),
        websocket: { message() {} },
      },
      {
        appOrigin: "http://127.0.0.1:3001",
        hub: "ws://127.0.0.1:7100/client",
        mayUse: async (userId) => userId === "active",
      },
    );
    let upgraded = 0;
    const server = {
      upgrade: () => {
        upgraded += 1;
        return true;
      },
    } as never;
    const ask = (query: string) =>
      options.fetch(
        new Request(`https://192.168.1.20:52443/api/hub/client${query}`, {
          headers: { host: "192.168.1.20:52443", upgrade: "websocket" },
        }),
        server,
      );
    expect((await ask(`?join_token=${token("removed")}`))?.status).toBe(403);
    expect((await ask(""))?.status).toBe(401);
    expect(upgraded).toBe(0);
    expect(await ask(`?join_token=${token("active")}`)).toBeUndefined();
    expect(upgraded).toBe(1);
  });
});

describe("set-up with password sign-in and no secret (R6)", () => {
  test("is refused, rather than open to whoever comes first", async () => {
    const service = {
      setupNeeded: async () => true,
      setup: async () => ({ userId: "u-1" }),
    } as unknown as TeamService;
    const app = new Hono().route(
      "/api/team",
      teamSetupRoutes(service, { tokenRequired: true }),
    );
    const answer = await app.request("/api/team/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Maria",
        email: "maria@shop.example",
        password: "a-long-password",
      }),
    });
    expect(answer.status).toBe(403);
    expect((await answer.json()).code).toBe("setup_secret_missing");
  });
});

describe("the wrong-password limiter's edges", () => {
  test("a server error is not counted as a wrong password, a throw is", async () => {
    const limiter = createAttemptLimiter({ maxFailures: 2 });
    let mode: "down" | "throw" = "down";
    const app = new Hono();
    app.use("/sign-in", attemptGuard({ limiter, keyOf: async () => "maria" }));
    app.post("/sign-in", (context) => {
      if (mode === "throw") throw new Error("boom");
      return context.json({ error: "database down" }, 503);
    });
    for (let i = 0; i < 5; i++)
      expect((await app.request("/sign-in", { method: "POST" })).status).toBe(
        503,
      );
    expect(limiter.lockedFor("maria")).toBe(0);
    mode = "throw";
    await app.request("/sign-in", { method: "POST" });
    await app.request("/sign-in", { method: "POST" });
    expect(limiter.lockedFor("maria")).toBeGreaterThan(0);
  });

  test("a second attempt while one is still checked is told so, not locked", async () => {
    const limiter = createAttemptLimiter();
    const app = new Hono();
    app.use("/sign-in", attemptGuard({ limiter, keyOf: async () => "maria" }));
    app.post("/sign-in", async (context) => {
      await Bun.sleep(30);
      return context.json({}, 401);
    });
    const [, second] = await Promise.all([
      app.request("/sign-in", { method: "POST" }),
      app.request("/sign-in", { method: "POST" }),
    ]);
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe("attempt_in_progress");
  });

  test("a flood of made-up accounts cannot grow the memory without end", () => {
    const limiter = createAttemptLimiter();
    for (let i = 0; i < 30_000; i++) limiter.fail(`made-up-${i}@x.example`);
    // The real account's lock survives the flood.
    for (let i = 0; i < 5; i++) limiter.fail("maria");
    for (let i = 0; i < 30_000; i++) limiter.fail(`more-${i}@x.example`);
    expect(limiter.lockedFor("maria")).toBeGreaterThan(0);
  });
});

describe("model addresses a staff sub-profile may use (F4)", () => {
  test("this computer, the office network and other private ranges are private", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "[::1]",
      "fe80::1",
      "fd00::1",
      "::ffff:192.168.1.1",
      "0.0.0.0",
    ])
      expect(isPrivateAddress(address)).toBe(true);
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "1.1.1.1",
      "2606:4700::1111",
    ])
      expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("the audit trail of team and office changes (F6)", () => {
  test("each change is named by its route; reads are not", () => {
    expect(teamAuditEvent("POST", "/api/team/setup")?.eventType).toBe(
      "team.administrator_made",
    );
    expect(teamAuditEvent("POST", "/api/team/members")?.eventType).toBe(
      "team.member_added",
    );
    expect(teamAuditEvent("DELETE", "/api/team/members/u-2")).toEqual({
      eventType: "team.member_removed",
      targetType: "person",
      targetId: "u-2",
    });
    expect(
      teamAuditEvent("PUT", "/api/team/members/u-2/agents")?.eventType,
    ).toBe("team.member_agents_changed");
    expect(teamAuditEvent("POST", "/api/team/me/password")?.eventType).toBe(
      "team.password_changed",
    );
    expect(teamAuditEvent("POST", "/api/auth/change-password")?.eventType).toBe(
      "team.password_changed",
    );
    expect(teamAuditEvent("POST", "/api/team/billing/sync")?.eventType).toBe(
      "team.billing_synced",
    );
    expect(teamAuditEvent("PUT", "/api/team/office")?.eventType).toBe(
      "office.settings_changed",
    );
    expect(
      teamAuditEvent("POST", "/api/team/office/join-code")?.eventType,
    ).toBe("office.join_code_renewed");
    expect(teamAuditEvent("GET", "/api/team/members")).toBeNull();
    expect(teamAuditEvent("GET", "/api/team/office")).toBeNull();
  });
});

describe("a password change keeps the session it came from (F9)", () => {
  test("the session token is read from Better Auth's cookie", () => {
    expect(sessionToken("better-auth.session_token=abc.sig; other=1")).toBe(
      "abc",
    );
    expect(
      sessionToken("x=1; __Secure-better-auth.session_token=def%2Esig"),
    ).toBe("def");
    expect(sessionToken("x=1")).toBeUndefined();
  });
});

afterEach(() => {});

describe("a sub-profile on its first password (F9, C3 of the v0.1.56 review)", () => {
  test("reaches only who it is and the first sign-in's steps, until it chooses its own", async () => {
    const { createRequireUser } = await import("../src/auth/guards");
    let first = true;
    const guard = createRequireUser(
      {
        api: {
          getSession: async () => ({
            user: {
              id: "u-1",
              email: "n@shop.example",
              name: "N",
              role: "user",
            },
          }),
        },
      } as never,
      { rolesForUser: async () => ["user"] } as never,
      async () => ({ ok: true }),
      async () =>
        first
          ? { ok: false, reason: "Choose your own password first." }
          : { ok: true },
    );
    const app = new Hono();
    app.use("/api/*", guard);
    app.all("/api/*", (context) => context.text("ok"));
    for (const open of [
      "/api/me",
      "/api/team/me",
      "/api/team/me/password",
      "/api/me/terms",
    ])
      expect((await app.request(open)).status).toBe(200);
    for (const closed of [
      "/api/agents",
      "/api/channels",
      "/api/models/connections",
      "/api/me/x",
    ]) {
      const answer = await app.request(closed);
      expect(answer.status).toBe(403);
      expect((await answer.json()).code).toBe("password_change_required");
    }
    first = false;
    expect((await app.request("/api/agents")).status).toBe(200);
  });
});
