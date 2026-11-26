import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  attemptGuard,
  createAttemptLimiter,
  jsonSignInOnly,
  revokeOtherSessionsOnPasswordChange,
} from "../src/auth/attempts";
import {
  createPublicModelFetch,
  type GuardedFetch,
  HTTPS_ONLY_FOR_SUBPROFILE,
  modelFetchFor,
} from "../src/models/public-fetch";
import { isPrivateAddress } from "../src/models/routes";

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

describe("a sub-profile's model is checked when it is used, not only when it is saved", () => {
  const answered: string[] = [];
  const upstream = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    answered.push(url);
    if (url === "https://moves.example/v1/models")
      return new Response(null, {
        status: 307,
        headers: { location: "http://moves.example/v1/models" },
      });
    if (url === "https://wanders.example/v1/models")
      return new Response(null, {
        status: 307,
        headers: { location: "https://inside.example/v1/models" },
      });
    return Response.json({ data: [] });
  }) as typeof fetch;
  const names: Record<string, string[]> = {
    "api.example": ["93.184.216.34"],
    "moves.example": ["93.184.216.34"],
    "wanders.example": ["93.184.216.34"],
    // A public name pointed at the office network after it was saved.
    "repointed.example": ["192.168.1.20"],
    "inside.example": ["10.0.0.5"],
  };
  const send = createPublicModelFetch({
    fetchImpl: upstream,
    resolve: async (host) => names[host] ?? [],
  });

  test("a public https address is reached", async () => {
    expect((await send("https://api.example/v1/models")).status).toBe(200);
  });
  test("a name that now points at the office network is refused at the call", async () => {
    await expect(send("https://repointed.example/v1/models")).rejects.toThrow(
      /inside the deployment's own network/,
    );
  });
  test("http is refused, so a re-pointed name cannot get past the certificate", async () => {
    await expect(send("http://api.example/v1/models")).rejects.toThrow(
      HTTPS_ONLY_FOR_SUBPROFILE,
    );
  });
  test("a redirect to http, or to a private name, is refused too", async () => {
    await expect(send("https://moves.example/v1/models")).rejects.toThrow(
      HTTPS_ONLY_FOR_SUBPROFILE,
    );
    await expect(send("https://wanders.example/v1/models")).rejects.toThrow(
      /inside the deployment's own network/,
    );
    expect(answered).not.toContain("https://inside.example/v1/models");
  });
  test("private addresses typed as numbers are refused", async () => {
    for (const address of [
      "https://127.0.0.1/v1",
      "https://[::1]/v1",
      "https://192.168.1.2/v1",
    ])
      await expect(send(address)).rejects.toThrow();
  });
  test("only a sub-profile gets the public fetch; failing to tell counts as one", async () => {
    const standard = (async () => new Response("standard")) as GuardedFetch;
    const publicOnly = (async () => new Response("public")) as GuardedFetch;
    const pick = modelFetchFor({
      standard,
      publicOnly,
      isSubprofile: async (id) => {
        if (id === "broken") throw new Error("no database");
        return id === "staff";
      },
    });
    expect(await pick("owner")).toBe(standard);
    expect(await pick("staff")).toBe(publicOnly);
    expect(await pick("broken")).toBe(publicOnly);
  });
});

describe("the model address check knows every range that is not the internet", () => {
  test.each([
    "198.18.0.1",
    "198.19.255.254",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::ffff:192.168.0.1]",
    "::ffff:a00:5",
    "64:ff9b::a00:5",
    "fec0::1",
    "ff02::1",
  ])("%s is private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
  test.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])(
    "%s is public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("a password change through Better Auth's route signs out the other sessions", () => {
  function app() {
    const seen: unknown[] = [];
    const hono = new Hono();
    hono.use("/change-password", revokeOtherSessionsOnPasswordChange());
    hono.post("/change-password", async (context) => {
      seen.push(await context.req.json());
      return context.json({ ok: true });
    });
    return { hono, seen };
  }
  const json = { "content-type": "application/json" };

  test("revokeOtherSessions is always true, even when the request said false or left it out", async () => {
    const { hono, seen } = app();
    for (const extra of [{}, { revokeOtherSessions: false }]) {
      const response = await hono.request("/change-password", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          currentPassword: "old-password-1",
          newPassword: "new-password-1",
          ...extra,
        }),
      });
      expect(response.status).toBe(200);
    }
    expect(seen).toEqual([
      {
        currentPassword: "old-password-1",
        newPassword: "new-password-1",
        revokeOtherSessions: true,
      },
      {
        currentPassword: "old-password-1",
        newPassword: "new-password-1",
        revokeOtherSessions: true,
      },
    ]);
  });

  test("a web form is refused before anything is checked", async () => {
    const { hono, seen } = app();
    const response = await hono.request("/change-password", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "currentPassword=a&newPassword=b&revokeOtherSessions=false",
    });
    expect(response.status).toBe(415);
    expect(seen).toEqual([]);
  });
});
