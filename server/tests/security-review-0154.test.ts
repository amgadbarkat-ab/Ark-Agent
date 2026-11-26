import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TeamService } from "../src/accounts/team";
import {
  SETUP_TOKEN_HEADER,
  teamSetupRoutes,
} from "../src/accounts/team-routes";
import { attemptGuard, createAttemptLimiter } from "../src/auth/attempts";
import { hostAllowed, hostName } from "../src/office/hosts";

/**
 * The fixes from the security review of v0.1.54 (25 Nov 2026) that need no database: the Host a
 * request may name, wrong-password limits, and the set-up that only the install's own window can do.
 */
describe("which Host this computer answers", () => {
  test("its own names and any address; never a domain somebody can point at it", () => {
    for (const ok of [
      "localhost:52101",
      "127.0.0.1:52101",
      "[::1]:52101",
      "::1",
      "192.168.1.20:52443",
      "host.docker.internal:52101",
      "host.containers.internal:52101",
      "app.localhost:3000",
      null,
    ])
      expect(hostAllowed(ok)).toBe(true);
    for (const refused of [
      "attacker.example:52101",
      "localhost.attacker.example:52101",
      "127.0.0.1.nip.io:52101",
      "maria-pc:52443",
    ])
      expect(hostAllowed(refused)).toBe(false);
    // The computer's own name, where the listener says so.
    expect(hostAllowed("maria-pc:52443", ["maria-pc"])).toBe(true);
    expect(hostName("[::1]:3000")).toBe("::1");
    expect(hostName("Example.COM:80")).toBe("example.com");
  });
});

describe("wrong passwords", () => {
  test("five in fifteen minutes lock the account for fifteen; a right one starts the count again", () => {
    let now = 0;
    const limiter = createAttemptLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) expect(limiter.fail("maria")).toBe(false);
    limiter.succeed("maria");
    for (let i = 0; i < 4; i++) expect(limiter.fail("maria")).toBe(false);
    expect(limiter.lockedFor("maria")).toBe(0);
    expect(limiter.fail("maria")).toBe(true);
    expect(limiter.lockedFor("maria")).toBe(15 * 60_000);
    // Somebody else is not locked by it.
    expect(limiter.lockedFor("nikos")).toBe(0);
    now += 15 * 60_000;
    expect(limiter.lockedFor("maria")).toBe(0);
  });

  test("the route refuses while locked, without asking the password at all, and says so", async () => {
    const limiter = createAttemptLimiter();
    const asked: string[] = [];
    const failures: boolean[] = [];
    const app = new Hono();
    app.use(
      "/sign-in",
      attemptGuard({
        limiter,
        keyOf: async (context) => context.req.header("x-email") ?? "",
        onFailure: async (_context, locked) => {
          failures.push(locked);
        },
      }),
    );
    app.post("/sign-in", (context) => {
      asked.push("asked");
      return context.req.header("x-password") === "right"
        ? context.json({ ok: true })
        : context.json({ error: "no" }, 401);
    });
    const attempt = (password: string) =>
      app.request("/sign-in", {
        method: "POST",
        headers: { "x-email": "maria", "x-password": password },
      });
    for (let i = 0; i < 5; i++)
      expect((await attempt("wrong")).status).toBe(401);
    expect(failures).toEqual([false, false, false, false, true]);
    const locked = await attempt("right");
    expect(locked.status).toBe(429);
    expect((await locked.json()).code).toBe("too_many_attempts");
    // The locked attempt never reached the password check, right password or not.
    expect(asked).toHaveLength(5);
  });
});

describe("wrong passwords sent all at once (security review of v0.1.55)", () => {
  test("a burst is answered one at a time: only one reaches the password check while it runs", async () => {
    const limiter = createAttemptLimiter();
    let checking = 0;
    let most = 0;
    let checked = 0;
    const app = new Hono();
    app.use("/sign-in", attemptGuard({ limiter, keyOf: async () => "maria" }));
    app.post("/sign-in", async (context) => {
      checking += 1;
      checked += 1;
      most = Math.max(most, checking);
      await Bun.sleep(20);
      checking -= 1;
      return context.json({ error: "no" }, 401);
    });
    const burst = await Promise.all(
      Array.from({ length: 50 }, () =>
        app.request("/sign-in", { method: "POST" }),
      ),
    );
    expect(most).toBe(1);
    expect(checked).toBe(1);
    expect(burst.filter((one) => one.status === 429)).toHaveLength(49);
    // One after another: the fifth wrong one locks it, and nothing more is checked.
    for (let i = 0; i < 10; i++)
      await app.request("/sign-in", { method: "POST" });
    expect(checked).toBe(5);
  });

  test("an attempt nobody can be counted against (no session) passes through uncounted", async () => {
    const limiter = createAttemptLimiter();
    const app = new Hono();
    app.use("/change", attemptGuard({ limiter, keyOf: async () => null }));
    app.post("/change", (context) => context.json({ error: "Sign in" }, 401));
    for (let i = 0; i < 20; i++)
      expect((await app.request("/change", { method: "POST" })).status).toBe(
        401,
      );
  });
});

describe("making the administrator", () => {
  const service = {
    setupNeeded: async () => true,
    setup: async (input: { email: string }) => ({
      userId: "u-1",
      email: input.email,
    }),
  } as unknown as TeamService;
  const app = new Hono().route(
    "/api/team",
    teamSetupRoutes(service, { setupToken: "the-window-secret" }),
  );
  const make = (headers: Record<string, string>) =>
    app.request("/api/team/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        name: "Maria",
        email: "maria@shop.example",
        password: "a-long-password",
      }),
    });

  test("only the install's own window, which holds the secret, can do it", async () => {
    const without = await make({});
    expect(without.status).toBe(403);
    expect((await without.json()).code).toBe("setup_window_only");
    expect((await make({ [SETUP_TOKEN_HEADER]: "a-guess" })).status).toBe(403);
    expect(
      (await make({ [SETUP_TOKEN_HEADER]: "the-window-secret" })).status,
    ).toBe(201);
  });
});
