import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  attemptGuard,
  createAttemptLimiter,
  jsonSignInOnly,
} from "../src/auth/attempts";

/**
 * The fixes from the Security Engineer's full review of v0.1.56 (26 Nov 2026) that need no
 * database. Finding 1: the wrong-password lock was got round with a web-form sign-in.
 */
describe("the wrong-password lock cannot be got round with a web form (finding 1)", () => {
  function signInApp() {
    const limiter = createAttemptLimiter();
    const app = new Hono();
    app.use("/sign-in", jsonSignInOnly());
    app.use(
      "/sign-in",
      attemptGuard({
        limiter,
        keyOf: async (context) => {
          const body = (await context.req.raw
            .clone()
            .json()
            .catch(() => null)) as { email?: string } | null;
          const email = body?.email?.trim().toLowerCase() ?? "";
          return email ? `sign-in:office:${email}` : null;
        },
      }),
    );
    // Stands in for Better Auth, which reads both JSON and a web form.
    app.post("/sign-in", async (context) => {
      const type = context.req.header("content-type") ?? "";
      const body = type.includes("json")
        ? await context.req.json()
        : Object.fromEntries(new URLSearchParams(await context.req.text()));
      const right =
        (body.email === "admin@shop.example" &&
          body.password === "admin-pass") ||
        (body.email === "nikos@shop.example" && body.password === "nikos-pass");
      return context.json({}, right ? 200 : 401);
    });
    return app;
  }
  const form = (email: string, password: string) =>
    new URLSearchParams({ email, password }).toString();
  const json = (email: string, password: string) =>
    JSON.stringify({ email, password });

  test("a web-form sign-in is refused before any password is checked", async () => {
    const app = signInApp();
    const answer = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form("admin@shop.example", "admin-pass"),
    });
    expect(answer.status).toBe(415);
    expect((await answer.json()).code).toBe("json_only");
    const none = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: json("admin@shop.example", "admin-pass"),
    });
    expect(none.status).toBe(415);
  });

  test("the reviewer's attack: 4 wrong for the administrator, 1 right for oneself, repeated, now locks", async () => {
    const app = signInApp();
    const send = (body: string) =>
      app.request("/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    const seen: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++)
        seen.push(
          (await send(json("admin@shop.example", `guess-${round}-${i}`)))
            .status,
        );
      expect(
        (await send(json("nikos@shop.example", "nikos-pass"))).status,
      ).toBe(200);
    }
    // The fifth wrong guess locks the administrator's account; Nikos's own sign-ins clear nothing of it.
    expect(seen.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(seen[4]).toBe(401);
    expect(seen.slice(5)).toEqual(Array(7).fill(429));
    expect((await send(json("admin@shop.example", "admin-pass"))).status).toBe(
      429,
    );
  });

  test("a sign-in with no email is refused, never counted under one shared key", async () => {
    const app = signInApp();
    for (let i = 0; i < 10; i++) {
      const answer = await app.request("/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "x" }),
      });
      expect(answer.status).toBe(400);
    }
    const real = await app.request("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json("admin@shop.example", "admin-pass"),
    });
    expect(real.status).toBe(200);
  });
});
