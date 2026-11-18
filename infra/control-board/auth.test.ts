import { afterEach, describe, expect, test } from "bun:test";
import type { AccessCheck } from "./access";
import { readAudit } from "./audit";
import {
  Browser,
  type TestBoard,
  testBoard,
  VirtualAuthenticator,
} from "./test-helpers";
import { totp } from "./totp";

let current: TestBoard | null = null;
async function setup(options?: Parameters<typeof testBoard>[1]) {
  current = await testBoard(undefined, options);
  return current;
}
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function lastAudit(t: TestBoard) {
  return (await readAudit(t.sql, 1, 0))[0];
}

describe("signing in with a passkey and the board's TOTP", () => {
  test("nothing is shown before sign-in: every page sends you to the sign-in form", async () => {
    const t = await setup();
    const browser = t.browser();
    for (const path of [
      "/",
      "/customers",
      "/customers/demo-shop",
      "/services",
      "/issues",
      "/audit",
      "/accounts",
      "/billing",
    ]) {
      const page = await browser.get(path);
      expect(page.status).toBe(303);
      expect(page.location).toBe("/login");
    }
    const login = await browser.get("/login");
    expect(login.text).toContain('data-passkey="/login/options"');
    expect(login.text).toContain('name="code"');
    expect(login.text).not.toContain('name="password"');
    expect(login.text).toContain('<script src="/webauthn.js" defer></script>');
    expect(login.text).not.toContain("demo-");
  });

  test("the passkey and a TOTP code sign you in, with a short-lived, locked-down cookie", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    const signedIn = await browser.signIn("maria", t.code("maria"));
    expect(signedIn.status).toBe(303);
    expect(signedIn.location).toBe("/");
    const cookie = signedIn.response.headers
      .getSetCookie()
      .find((line) => line.startsWith("__Host-ark_board="));
    for (const part of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
      "Max-Age=28800",
    ])
      expect(cookie).toContain(part);
    expect(cookie).not.toContain("Domain=");
    const home = await browser.get("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("maria");
    const signIns = (await readAudit(t.sql, 10, 0)).filter(
      (row) => row.action === "sign-in",
    );
    expect(signIns).toMatchObject([
      { actor: "maria", role: "support", outcome: "ok", detail: "passkey" },
    ]);
  });

  test("the passkey without the right code does not sign in, and neither does a code without the passkey", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    expect((await t.browser().signIn("maria", "000000")).status).toBe(401);
    // A code alone, with no passkey at all.
    const stranger = new VirtualAuthenticator();
    expect(
      (await t.browser().signIn("maria", t.code("maria"), stranger)).status,
    ).toBe(401);
    expect(await lastAudit(t)).toMatchObject({
      action: "sign-in",
      outcome: "refused",
      detail: "unknown passkey",
    });
  });

  test("a passkey answer for another site, or signed with another key, is refused", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const passkey = t.authenticators.get("maria") as VirtualAuthenticator;
    const browser = t.browser();
    const page = await browser.get("/login");
    const csrf = Browser.csrfFrom(page.text);
    const phishing = await browser.passkeyForm(
      "/login/options",
      "/login",
      csrf,
      (publicKey) =>
        passkey.signIn(publicKey, { origin: "https://board-example.evil" }),
      { code: t.code("maria") },
    );
    expect(phishing.status).toBe(401);
    expect(await lastAudit(t)).toMatchObject({
      detail: "passkey: wrong origin",
    });
    const other = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    )) as CryptoKeyPair;
    const forged = await browser.passkeyForm(
      "/login/options",
      "/login",
      csrf,
      (publicKey) => passkey.signIn(publicKey, { key: other.privateKey }),
      { code: t.code("maria") },
    );
    expect(forged.status).toBe(401);
    expect(await lastAudit(t)).toMatchObject({
      detail: "passkey: bad signature",
    });
  });

  test("a challenge is used once: a replayed passkey answer is refused", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const passkey = t.authenticators.get("maria") as VirtualAuthenticator;
    const browser = t.browser();
    const csrf = Browser.csrfFrom((await browser.get("/login")).text);
    const options = JSON.parse(
      (await browser.post("/login/options", { csrf })).text,
    );
    const answer = await passkey.signIn(options.publicKey);
    const fields = {
      csrf,
      challengeId: options.challengeId,
      ...answer,
      code: t.code("maria"),
    };
    expect((await browser.post("/login", fields)).status).toBe(303);
    t.clock.now += 30_000;
    // Another browser, with its own form token, replays the same passkey answer.
    const replay = t.browser();
    const replayCsrf = Browser.csrfFrom((await replay.get("/login")).text);
    expect(
      (
        await replay.post("/login", {
          ...fields,
          csrf: replayCsrf,
          code: t.code("maria"),
        })
      ).status,
    ).toBe(401);
    expect(await lastAudit(t)).toMatchObject({ detail: "challenge" });
  });

  test("a TOTP code that was already used cannot sign in again", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const code = t.code("maria");
    expect((await t.browser().signIn("maria", code)).status).toBe(303);
    t.clock.now += 5_000;
    expect((await t.browser().signIn("maria", code)).status).toBe(401);
    t.clock.now += 30_000;
    expect((await t.browser().signIn("maria", t.code("maria"))).status).toBe(
      303,
    );
  });

  test("after 5 failures an account is locked for 15 minutes, even with the right passkey and code", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    for (let i = 0; i < 5; i++)
      expect((await t.browser().signIn("maria", "000000")).status).toBe(401);
    const locked = await t.browser().signIn("maria", t.code("maria"));
    expect(locked.status).toBe(429);
    expect(await lastAudit(t)).toMatchObject({
      action: "sign-in",
      outcome: "refused",
      detail: "locked",
    });
    t.clock.now += 15 * 60_000 + 1;
    expect((await t.browser().signIn("maria", t.code("maria"))).status).toBe(
      303,
    );
  });

  test("one address is stopped after 20 failures, whoever it tries", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    for (let i = 0; i < 20; i++)
      await t.browser().signIn("nobody", "123456", new VirtualAuthenticator());
    expect((await t.browser().signIn("maria", t.code("maria"))).status).toBe(
      429,
    );
    const elsewhere = t.browser();
    elsewhere.ip = "198.51.100.9";
    expect((await elsewhere.signIn("maria", t.code("maria"))).status).toBe(303);
  });

  test("the sign-in form and its passkey options need the pre-session CSRF token", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.get("/login");
    expect(
      (await browser.post("/login/options", { csrf: "x".repeat(43) })).status,
    ).toBe(403);
    expect(
      (
        await browser.post("/login", {
          csrf: "x".repeat(43),
          code: t.code("maria"),
        })
      ).status,
    ).toBe(403);
    expect(await lastAudit(t)).toMatchObject({
      action: "sign-in",
      outcome: "refused",
      detail: "csrf",
    });
  });

  test("a disabled account cannot sign in", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    await t.sql.run(
      "UPDATE accounts SET status = 'disabled' WHERE username = 'maria'",
    );
    expect((await t.browser().signIn("maria", t.code("maria"))).status).toBe(
      401,
    );
  });
});

describe("sessions", () => {
  test("a session ends after 15 minutes without a request, and after 8 hours in any case", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", t.code("maria"));
    t.clock.now += 14 * 60_000;
    expect((await browser.get("/")).status).toBe(200);
    t.clock.now += 15 * 60_000 + 1;
    const ended = await browser.get("/");
    expect(ended.location).toBe("/login?ended=1");

    const long = t.browser();
    t.clock.now += 60_000;
    await long.signIn("maria", t.code("maria"));
    for (let minutes = 10; minutes <= 8 * 60; minutes += 10) {
      t.clock.now += 10 * 60_000;
      if (minutes < 8 * 60)
        expect((await long.get("/services")).status).toBe(200);
    }
    t.clock.now += 1;
    expect((await long.get("/services")).status).toBe(303);
  });

  test("signing out ends the session, and needs the CSRF token", async () => {
    const t = await setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", t.code("maria"));
    const home = await browser.get("/");
    expect((await browser.post("/logout", { csrf: "wrong" })).status).toBe(403);
    expect(
      (await browser.post("/logout", { csrf: Browser.csrfFrom(home.text) }))
        .status,
    ).toBe(303);
    expect((await browser.get("/")).status).toBe(303);
    expect(await lastAudit(t)).toMatchObject({
      actor: "maria",
      action: "sign-out",
    });
  });

  test("a POST from another site is refused even with the token", async () => {
    const t = await setup();
    await t.addAccount("maria", "admin");
    const browser = t.browser();
    await browser.signIn("maria", t.code("maria"));
    const csrf = Browser.csrfFrom((await browser.get("/accounts")).text);
    const crossSite = await browser.post(
      "/accounts",
      { csrf, action: "create", username: "evil", role: "support" },
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);
  });
});

describe("roles", () => {
  async function as(role: "owner" | "admin" | "support" | "read-only") {
    const t = await setup();
    await t.addAccount("person", role);
    const browser = t.browser();
    await browser.signIn("person", t.code("person"));
    return { t, browser };
  }

  test("support and read-only see the data pages, not the audit log or accounts", async () => {
    for (const role of ["support", "read-only"] as const) {
      const { t, browser } = await as(role);
      for (const path of [
        "/",
        "/customers",
        "/customers/demo-shop",
        "/services",
        "/issues",
        "/billing",
      ]) {
        expect((await browser.get(path)).status).toBe(200);
      }
      expect((await browser.get("/audit")).status).toBe(403);
      expect((await browser.get("/accounts")).status).toBe(403);
      expect(await lastAudit(t)).toMatchObject({
        action: "refused",
        target: "GET /accounts",
        outcome: "refused",
      });
      current?.cleanup();
      current = null;
    }
  });

  test("an admin adds support and read-only accounts, never an owner or another admin", async () => {
    const { t, browser } = await as("admin");
    const csrf = Browser.csrfFrom((await browser.get("/accounts")).text);
    const ok = await browser.post("/accounts", {
      csrf,
      action: "create",
      username: "eleni",
      role: "support",
    });
    expect(ok.text).toMatch(
      /https:\/\/board\.example\/setup\/[A-Za-z0-9_-]{43}/,
    );
    for (const role of ["owner", "admin"]) {
      expect(
        (
          await browser.post("/accounts", {
            csrf,
            action: "create",
            username: `x-${role}`,
            role,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      await t.sql.all(
        "SELECT username, role, status FROM accounts ORDER BY username",
      ),
    ).toEqual([
      { username: "eleni", role: "support", status: "pending" },
      { username: "person", role: "admin", status: "active" },
    ]);
  });

  test("disabling an account ends its sessions at once", async () => {
    const { t, browser } = await as("owner");
    await t.addAccount("eleni", "support");
    const eleni = t.browser();
    await eleni.signIn("eleni", t.code("eleni"));
    expect((await eleni.get("/")).status).toBe(200);
    const csrf = Browser.csrfFrom((await browser.get("/accounts")).text);
    expect(
      (
        await browser.post("/accounts", {
          csrf,
          action: "disable",
          username: "eleni",
        })
      ).status,
    ).toBe(200);
    expect((await eleni.get("/")).status).toBe(303);
  });
});

describe("a new account's setup link", () => {
  async function made(t: TestBoard) {
    await t.addAccount("boss", "owner");
    const owner = t.browser();
    await owner.signIn("boss", t.code("boss"));
    const csrf = Browser.csrfFrom((await owner.get("/accounts")).text);
    const page = await owner.post("/accounts", {
      csrf,
      action: "create",
      username: "eleni",
      role: "read-only",
    });
    return (
      page.text.match(
        /https:\/\/board\.example(\/setup\/[A-Za-z0-9_-]{43})/,
      )?.[1] ?? ""
    );
  }

  test("registers a passkey and the TOTP key once; then the person signs in with them", async () => {
    const t = await setup();
    const path = await made(t);
    const eleni = t.browser();
    const form = await eleni.get(path);
    expect(form.text).toContain(`data-passkey="${path}/options"`);
    const secret = form.text.match(/secret=([A-Z2-7]+)/)?.[1] ?? "";
    const csrf = Browser.csrfFrom(form.text);
    const passkey = new VirtualAuthenticator();
    const wrongCode = await eleni.passkeyForm(
      `${path}/options`,
      path,
      csrf,
      (pk) => passkey.register(pk),
      { code: "000000" },
    );
    expect(wrongCode.status).toBe(400);
    const done = await eleni.passkeyForm(
      `${path}/options`,
      path,
      csrf,
      (pk) => passkey.register(pk),
      {
        code: totp(secret, t.clock.now),
      },
    );
    expect(done.text).toContain("Setup is done");
    expect((await t.browser().get(path)).status).toBe(404);
    t.clock.now += 30_000;
    expect(
      (await eleni.signIn("eleni", totp(secret, t.clock.now), passkey)).status,
    ).toBe(303);
    expect((await eleni.get("/customers")).status).toBe(200);
  });

  test("a passkey made for another site is refused at setup", async () => {
    const t = await setup();
    const path = await made(t);
    const eleni = t.browser();
    const form = await eleni.get(path);
    const secret = form.text.match(/secret=([A-Z2-7]+)/)?.[1] ?? "";
    const passkey = new VirtualAuthenticator("https://evil.example");
    const refused = await eleni.passkeyForm(
      `${path}/options`,
      path,
      Browser.csrfFrom(form.text),
      (pk) => passkey.register(pk),
      {
        code: totp(secret, t.clock.now),
      },
    );
    expect(refused.status).toBe(400);
    expect(await lastAudit(t)).toMatchObject({
      action: "account.setup",
      detail: "passkey: wrong origin",
    });
  });

  test("a setup link stops working after 24 hours", async () => {
    const t = await setup();
    const path = await made(t);
    t.clock.now += 24 * 3_600_000 + 1;
    expect((await t.browser().get(path)).status).toBe(404);
  });
});

describe("behind Cloudflare Access (FIRST_FACTOR=access)", () => {
  const accessFor =
    (allowed: Record<string, string>): AccessCheck =>
    async (request) => {
      const email =
        allowed[request.headers.get("cf-access-jwt-assertion") ?? ""];
      return email
        ? { ok: true, email }
        : { ok: false, reason: "no assertion" };
    };
  const access = accessFor({
    "jwt-maria": "maria@blackark.example",
    "jwt-guest": "guest@blackark.example",
  });

  test("Access's email names the account; the board's TOTP is still asked for", async () => {
    const t = await setup({ firstFactor: "access", access });
    await t.addAccount("maria", "support", "maria@blackark.example");
    const browser = t.browser();
    browser.extraHeaders["cf-access-jwt-assertion"] = "jwt-maria";
    const page = await browser.get("/login");
    expect(page.text).toContain("<strong>maria</strong>");
    expect(page.text).not.toContain("data-passkey");
    expect((await browser.signInWithCode("000000")).status).toBe(401);
    expect((await browser.signInWithCode(t.code("maria"))).status).toBe(303);
    expect((await browser.get("/")).status).toBe(200);
  });

  test("an Access email with no account gets nothing, and no assertion is refused outright", async () => {
    const t = await setup({ firstFactor: "access", access });
    const guest = t.browser();
    guest.extraHeaders["cf-access-jwt-assertion"] = "jwt-guest";
    expect((await guest.get("/login")).status).toBe(403);
    const around = await t.browser().get("/login");
    expect(around.status).toBe(403);
    expect(around.text).toBe("Not through Cloudflare Access.");
  });

  test("a session is tied to the person Access let through", async () => {
    const t = await setup({ firstFactor: "access", access });
    await t.addAccount("maria", "support", "maria@blackark.example");
    const browser = t.browser();
    browser.extraHeaders["cf-access-jwt-assertion"] = "jwt-maria";
    await browser.signInWithCode(t.code("maria"));
    browser.extraHeaders["cf-access-jwt-assertion"] = "jwt-guest";
    expect((await browser.get("/")).status).toBe(303);
  });
});
