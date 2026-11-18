import { afterEach, describe, expect, test } from "bun:test";
import { readAudit } from "./audit";
import { Browser, testBoard } from "./test-helpers";
import { totp } from "./totp";

const PASSWORD = "correct horse battery";
let current: ReturnType<typeof testBoard> | null = null;
function setup() {
  current = testBoard();
  return current;
}
afterEach(() => {
  current?.cleanup();
  current = null;
});

function lastAudit(t: ReturnType<typeof testBoard>) {
  return readAudit(t.db, 1, 0)[0];
}

describe("signing in", () => {
  test("nothing is shown before sign-in: every page sends you to the login form", async () => {
    const t = setup();
    const browser = t.browser();
    for (const path of [
      "/",
      "/customers",
      "/customers/demo-shop",
      "/services",
      "/issues",
      "/audit",
      "/accounts",
    ]) {
      const page = await browser.get(path);
      expect(page.status).toBe(303);
      expect(page.location).toBe("/login");
      expect(page.text).not.toContain("demo-");
    }
    const login = await browser.get("/login");
    expect(login.text).toContain('name="password"');
    expect(login.text).toContain('name="code"');
    expect(login.text).not.toContain("demo-");
  });

  test("the password and a TOTP code sign you in, with a short-lived, locked-down cookie", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    const signedIn = await browser.signIn("maria", PASSWORD, t.code("maria"));
    expect(signedIn.status).toBe(303);
    expect(signedIn.location).toBe("/");
    const cookie = signedIn.response.headers
      .getSetCookie()
      .find((line) => line.startsWith("__Host-ark_board="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=28800");
    expect(cookie).not.toContain("Domain=");
    const home = await browser.get("/");
    expect(home.status).toBe(200);
    expect(home.text).toContain("maria");
    expect(lastAudit(t)).toMatchObject({
      actor: "maria",
      action: "view",
      target: "overview",
    });
    const signIns = readAudit(t.db, 10, 0).filter(
      (row) => row.action === "sign-in",
    );
    expect(signIns).toMatchObject([
      { actor: "maria", role: "support", outcome: "ok" },
    ]);
  });

  test("a right password without the right code does not sign in", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    const wrongCode = await browser.signIn("maria", PASSWORD, "000000");
    expect(wrongCode.status).toBe(401);
    expect(wrongCode.text).toContain("Wrong user name, password or code.");
    const noCode = await browser.signIn("maria", PASSWORD, "");
    expect(noCode.status).toBe(401);
    expect((await browser.get("/")).status).toBe(303);
    expect(lastAudit(t)).toMatchObject({
      action: "sign-in",
      target: "maria",
      outcome: "refused",
      detail: "code",
    });
  });

  test("a wrong password, an unknown name and a wrong code all get the same answer", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const answers = await Promise.all([
      t.browser().signIn("maria", "wrong password!!", t.code("maria")),
      t.browser().signIn("nobody", PASSWORD, t.code("maria")),
      t.browser().signIn("maria", PASSWORD, "123456"),
    ]);
    const bodies = answers.map((answer) =>
      answer.text.replace(/value="[^"]+"/g, ""),
    );
    expect(new Set(answers.map((answer) => answer.status))).toEqual(
      new Set([401]),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  test("a code that was already used cannot sign in again (replay)", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const code = t.code("maria");
    expect((await t.browser().signIn("maria", PASSWORD, code)).status).toBe(
      303,
    );
    t.clock.now += 5_000;
    expect((await t.browser().signIn("maria", PASSWORD, code)).status).toBe(
      401,
    );
    t.clock.now += 30_000;
    expect(
      (await t.browser().signIn("maria", PASSWORD, t.code("maria"))).status,
    ).toBe(303);
  });

  test("after 5 failures a name is locked for 15 minutes, even with the right password and code", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    for (let i = 0; i < 5; i++) {
      expect(
        (await t.browser().signIn("maria", "wrong password!!", t.code("maria")))
          .status,
      ).toBe(401);
    }
    const locked = await t.browser().signIn("maria", PASSWORD, t.code("maria"));
    expect(locked.status).toBe(429);
    expect(locked.text).toContain("Too many attempts");
    expect(lastAudit(t)).toMatchObject({
      action: "sign-in",
      outcome: "refused",
      detail: "locked",
    });
    t.clock.now += 14 * 60_000;
    expect(
      (await t.browser().signIn("maria", PASSWORD, t.code("maria"))).status,
    ).toBe(429);
    t.clock.now += 61_000;
    expect(
      (await t.browser().signIn("maria", PASSWORD, t.code("maria"))).status,
    ).toBe(303);
  });

  test("one address is stopped after 20 failures across any names", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    for (let i = 0; i < 20; i++) {
      await t.browser().signIn(`guess${i}`, "wrong password!!", "123456");
    }
    expect(
      (await t.browser().signIn("maria", PASSWORD, t.code("maria"))).status,
    ).toBe(429);
    const elsewhere = t.browser();
    elsewhere.ip = "198.51.100.9";
    expect(
      (await elsewhere.signIn("maria", PASSWORD, t.code("maria"))).status,
    ).toBe(303);
  });

  test("the login form without its CSRF token is refused", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.get("/login");
    const forged = await browser.post("/login", {
      csrf: "x".repeat(43),
      username: "maria",
      password: PASSWORD,
      code: t.code("maria"),
    });
    expect(forged.status).toBe(403);
    const fromElsewhere = await t.browser().post("/login", {
      username: "maria",
      password: PASSWORD,
      code: t.code("maria"),
    });
    expect(fromElsewhere.status).toBe(403);
    expect(lastAudit(t)).toMatchObject({
      action: "sign-in",
      outcome: "refused",
      detail: "csrf",
    });
  });

  test("a disabled account cannot sign in", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    t.db
      .query("UPDATE accounts SET status = 'disabled' WHERE username = 'maria'")
      .run();
    expect(
      (await t.browser().signIn("maria", PASSWORD, t.code("maria"))).status,
    ).toBe(401);
  });
});

describe("sessions", () => {
  test("a session ends after 15 minutes without a request", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", PASSWORD, t.code("maria"));
    t.clock.now += 14 * 60_000;
    expect((await browser.get("/")).status).toBe(200);
    t.clock.now += 14 * 60_000;
    expect((await browser.get("/")).status).toBe(200);
    t.clock.now += 15 * 60_000 + 1;
    const ended = await browser.get("/");
    expect(ended.status).toBe(303);
    expect(ended.location).toBe("/login?ended=1");
    expect((await browser.get("/login?ended=1")).text).toContain(
      "Your session ended",
    );
  });

  test("a session ends after 8 hours even when in use", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", PASSWORD, t.code("maria"));
    for (let minutes = 10; minutes < 8 * 60; minutes += 10) {
      t.clock.now += 10 * 60_000;
      expect((await browser.get("/services")).status).toBe(200);
    }
    t.clock.now += 10 * 60_000 + 1;
    expect((await browser.get("/services")).status).toBe(303);
  });

  test("signing out ends the session, and needs the CSRF token", async () => {
    const t = setup();
    await t.addAccount("maria", "support");
    const browser = t.browser();
    await browser.signIn("maria", PASSWORD, t.code("maria"));
    const home = await browser.get("/");
    expect((await browser.post("/logout", { csrf: "wrong" })).status).toBe(403);
    expect((await browser.get("/")).status).toBe(200);
    const out = await browser.post("/logout", {
      csrf: Browser.csrfFrom(home.text),
    });
    expect(out.status).toBe(303);
    expect((await browser.get("/")).status).toBe(303);
    expect(lastAudit(t)).toMatchObject({ actor: "maria", action: "sign-out" });
  });

  test("a stolen cookie value from another session does not carry its CSRF token", async () => {
    const t = setup();
    await t.addAccount("maria", "admin");
    await t.addAccount("nikos", "admin");
    const maria = t.browser();
    await maria.signIn("maria", PASSWORD, t.code("maria"));
    const nikos = t.browser();
    await nikos.signIn("nikos", PASSWORD, t.code("nikos"));
    const nikosToken = Browser.csrfFrom((await nikos.get("/accounts")).text);
    const forged = await maria.post("/accounts", {
      csrf: nikosToken,
      action: "create",
      username: "evil",
      role: "support",
    });
    expect(forged.status).toBe(403);
  });

  test("a POST from another site is refused even with the token", async () => {
    const t = setup();
    await t.addAccount("maria", "admin");
    const browser = t.browser();
    await browser.signIn("maria", PASSWORD, t.code("maria"));
    const csrf = Browser.csrfFrom((await browser.get("/accounts")).text);
    const crossSite = await browser.post(
      "/accounts",
      { csrf, action: "create", username: "evil", role: "support" },
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);
    expect(lastAudit(t)).toMatchObject({
      action: "refused",
      outcome: "refused",
      detail: "csrf",
    });
  });
});

describe("roles", () => {
  async function as(role: "owner" | "admin" | "support" | "read-only") {
    const t = setup();
    await t.addAccount("person", role);
    const browser = t.browser();
    await browser.signIn("person", PASSWORD, t.code("person"));
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
      ]) {
        expect((await browser.get(path)).status).toBe(200);
      }
      const audit = await browser.get("/audit");
      expect(audit.status).toBe(403);
      expect(audit.text).not.toContain("sign-in");
      expect((await browser.get("/accounts")).status).toBe(403);
      expect(lastAudit(t)).toMatchObject({
        action: "refused",
        target: "GET /accounts",
        outcome: "refused",
      });
      const home = await browser.get("/");
      expect(home.text).not.toContain('href="/audit"');
      expect(home.text).not.toContain('href="/accounts"');
      current?.cleanup();
      current = null;
    }
  });

  test("an admin adds support and read-only accounts, never an owner or another admin", async () => {
    const { t, browser } = await as("admin");
    const page = await browser.get("/accounts");
    const csrf = Browser.csrfFrom(page.text);
    expect(page.text).not.toContain('value="owner"');
    const ok = await browser.post("/accounts", {
      csrf,
      action: "create",
      username: "eleni",
      role: "support",
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toMatch(
      /https:\/\/board\.example\/setup\/[A-Za-z0-9_-]{43}/,
    );
    for (const role of ["owner", "admin"]) {
      const refused = await browser.post("/accounts", {
        csrf,
        action: "create",
        username: `x-${role}`,
        role,
      });
      expect(refused.status).toBe(403);
    }
    expect(
      t.db
        .query("SELECT username, role, status FROM accounts ORDER BY username")
        .all(),
    ).toEqual([
      { username: "eleni", role: "support", status: "pending" },
      { username: "person", role: "admin", status: "active" },
    ]);
  });

  test("an admin cannot disable or reset an owner", async () => {
    const { t, browser } = await as("admin");
    await t.addAccount("boss", "owner");
    const csrf = Browser.csrfFrom((await browser.get("/accounts")).text);
    expect(
      (
        await browser.post("/accounts", {
          csrf,
          action: "disable",
          username: "boss",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await browser.post("/accounts", {
          csrf,
          action: "reset",
          username: "boss",
        })
      ).status,
    ).toBe(403);
    expect(
      t.db.query("SELECT status FROM accounts WHERE username = 'boss'").get(),
    ).toEqual({ status: "active" });
  });

  test("disabling an account ends its sessions at once", async () => {
    const { t, browser } = await as("owner");
    await t.addAccount("eleni", "support");
    const eleni = t.browser();
    await eleni.signIn("eleni", PASSWORD, t.code("eleni"));
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
    expect(lastAudit(t)).toMatchObject({
      actor: "person",
      action: "account.disable",
      target: "eleni",
    });
  });
});

describe("a new account's setup link", () => {
  test("sets the password and 2FA once, then the person signs in", async () => {
    const t = setup();
    await t.addAccount("boss", "owner");
    const owner = t.browser();
    await owner.signIn("boss", PASSWORD, t.code("boss"));
    const csrf = Browser.csrfFrom((await owner.get("/accounts")).text);
    const made = await owner.post("/accounts", {
      csrf,
      action: "create",
      username: "eleni",
      role: "read-only",
    });
    const path =
      made.text.match(
        /https:\/\/board\.example(\/setup\/[A-Za-z0-9_-]{43})/,
      )?.[1] ?? "";
    expect(path).not.toBe("");

    const eleni = t.browser();
    const form = await eleni.get(path);
    expect(form.status).toBe(200);
    const secret = form.text.match(/secret=([A-Z2-7]+)/)?.[1] ?? "";
    expect(secret).toHaveLength(32);
    const formCsrf = Browser.csrfFrom(form.text);
    const short = await eleni.post(path, {
      csrf: formCsrf,
      password: "short",
      repeat: "short",
      code: totp(secret, t.clock.now),
    });
    expect(short.status).toBe(400);
    const wrongCode = await eleni.post(path, {
      csrf: formCsrf,
      password: "a long new password",
      repeat: "a long new password",
      code: "000000",
    });
    expect(wrongCode.status).toBe(400);
    const done = await eleni.post(path, {
      csrf: formCsrf,
      password: "a long new password",
      repeat: "a long new password",
      code: totp(secret, t.clock.now),
    });
    expect(done.status).toBe(200);
    expect(done.text).toContain("Setup is done");
    expect((await t.browser().get(path)).status).toBe(404);

    t.clock.now += 30_000;
    expect(
      (
        await eleni.signIn(
          "eleni",
          "a long new password",
          totp(secret, t.clock.now),
        )
      ).status,
    ).toBe(303);
    expect((await eleni.get("/customers")).status).toBe(200);
  });

  test("a setup link stops working after 24 hours", async () => {
    const t = setup();
    await t.addAccount("boss", "owner");
    const owner = t.browser();
    await owner.signIn("boss", PASSWORD, t.code("boss"));
    const csrf = Browser.csrfFrom((await owner.get("/accounts")).text);
    const made = await owner.post("/accounts", {
      csrf,
      action: "create",
      username: "eleni",
      role: "support",
    });
    const path =
      made.text.match(
        /https:\/\/board\.example(\/setup\/[A-Za-z0-9_-]{43})/,
      )?.[1] ?? "";
    t.clock.now += 24 * 3_600_000 + 1;
    expect((await t.browser().get(path)).status).toBe(404);
  });
});
