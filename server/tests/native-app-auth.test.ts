import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createApp } from "../src/app";
import { APP_RETURN_HOST, appAuthPage } from "../src/auth/native-browser";
import { loadConfig } from "../src/config";
import { isAppUrlScheme } from "../src/mobile/links";
import { testEnvironment } from "./support/environment";

/**
 * Signing in to the iOS app through the system browser.
 *
 * What is protected: the page only ever sends a person back to the app's own scheme, never anywhere
 * else; a code that another app on the phone picks out of the address is useless without the secret
 * that never left the app; a code works once; the app's session is its own, not the browser's.
 */

const SCHEME = "arkapp";
const state = "s".repeat(24);
const challenge = createHash("sha256")
  .update("v".repeat(43))
  .digest("base64url");

const query = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    provider: "google",
    state,
    code_challenge: challenge,
    redirect_uri: `${SCHEME}://${APP_RETURN_HOST}`,
    ...over,
  });

const page = (over: Record<string, string> = {}, providers = ["google"]) =>
  appAuthPage(
    new Request(`https://ark.example/api/auth/native?${query(over)}`),
    providers as never,
    SCHEME,
  );

describe("the scheme", () => {
  test("is an app's own name, never one the system or a browser already uses", () => {
    for (const good of ["arkapp", "ark-agent", "com.example.ark", "ark2"]) {
      expect(isAppUrlScheme(good)).toBe(true);
    }
    for (const bad of [
      "https",
      "http",
      "javascript",
      "file",
      "data",
      "mailto",
      "ab",
      "Ark",
      "1ark",
      "ark app",
      "ark://",
      "a".repeat(33),
      "",
    ]) {
      expect(isAppUrlScheme(bad)).toBe(false);
    }
  });
});

describe("the page", () => {
  test("starts a sign-in with the provider asked for, and hands back only through Better Auth's transfer", async () => {
    const response = page();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('"provider":"google"');
    expect(html).toContain("/api/auth/sign-in/social");
    expect(html).toContain("/api/auth/electron/transfer-user");
    expect(html).toContain(`"redirect":"${SCHEME}://${APP_RETURN_HOST}"`);
  });

  test("only runs its own script, only talks to its own site, and cannot be framed", () => {
    const policy = page().headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/script-src 'nonce-[^']+'/);
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(page().headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("a different nonce each time", () => {
    const nonce = (response: Response) =>
      /nonce-([^']+)/.exec(
        response.headers.get("content-security-policy") ?? "",
      )?.[1];
    expect(nonce(page())).not.toBe(nonce(page()));
  });

  test("takes only the app's own address to go back to", async () => {
    for (const bad of [
      "https://evil.example/signed-in",
      "https://ark.example/signed-in",
      `${SCHEME}://elsewhere`,
      `${SCHEME}://${APP_RETURN_HOST}/more`,
      `${SCHEME}://${APP_RETURN_HOST}?x=1`,
      `${SCHEME}://${APP_RETURN_HOST}#x`,
      `other://${APP_RETURN_HOST}`,
      "javascript:alert(1)",
      "",
    ]) {
      expect(page({ redirect_uri: bad }).status).toBe(400);
    }
  });

  test("takes only a state and a challenge of the right shape, and only a provider it can start", () => {
    expect(page({ state: "short" }).status).toBe(400);
    expect(page({ state: `${state}!` }).status).toBe(400);
    expect(page({ code_challenge: "a".repeat(42) }).status).toBe(400);
    expect(page({ code_challenge: `${"a".repeat(42)}+` }).status).toBe(400);
    expect(page({ provider: "okta" }, ["google", "okta"]).status).toBe(400);
    expect(page({ provider: "microsoft" }, ["google"]).status).toBe(400);
    expect(page({ provider: "<script>" }, ["google"]).status).toBe(400);
    expect(
      page({ provider: "microsoft" }, ["google", "microsoft"]).status,
    ).toBe(200);
  });

  test("cannot be made to write its own script into the page", async () => {
    const response = appAuthPage(
      new Request(
        `https://ark.example/api/auth/native?${query()}&x=%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E`,
      ),
      ["google"],
      SCHEME,
    );
    const html = await response.text();
    expect(html).not.toContain("</script><script>alert");
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe("the route", () => {
  const request = (extra: Record<string, string>) =>
    createApp(loadConfig(testEnvironment(extra))).request(
      `http://openbot.local/api/auth/native?${query()}`,
    );

  test("does not exist until the operator names the app's scheme", async () => {
    expect((await request({})).status).toBe(404);
  });

  test("exists once the scheme is named, and the scheme is public so the app can build its address", async () => {
    const config = { ARK_IOS_URL_SCHEME: SCHEME };
    expect((await request(config)).status).toBe(200);
    const app = createApp(loadConfig(testEnvironment(config)));
    const capabilities = (await (
      await app.request("http://openbot.local/api/capabilities")
    ).json()) as { appUrlScheme: string | null };
    expect(capabilities.appUrlScheme).toBe(SCHEME);
    const none = (await (
      await createApp(loadConfig(testEnvironment())).request(
        "http://openbot.local/api/capabilities",
      )
    ).json()) as { appUrlScheme: string | null };
    expect(none.appUrlScheme).toBeNull();
  });

  test("a scheme a browser would act on is refused when the server starts", () => {
    for (const bad of ["https", "javascript", "Ark", "ab"]) {
      expect(() =>
        loadConfig(testEnvironment({ ARK_IOS_URL_SCHEME: bad })),
      ).toThrow(/ARK_IOS_URL_SCHEME/);
    }
  });
});

/**
 * The exchange the app makes, run against Better Auth itself with the same plugin the server uses.
 * Two clients: the system browser, which holds the signed-in session, and the app, which holds nothing
 * but the secret it made.
 */
describe("handing the session to the app", () => {
  const origin = "http://localhost:39092";
  const auth = betterAuth({
    baseURL: origin,
    secret: "a-fixed-test-fixture-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [electron({ clientID: "openbot-desktop", codeExpiresIn: 120 })],
  });
  const verifier = "v".repeat(43);

  async function browserSession() {
    const signup = await auth.api.signUpEmail({
      body: {
        email: `person-${crypto.randomUUID()}@example.com`,
        password: "test-fixture-password",
        name: "Person",
      },
      asResponse: true,
    });
    return signup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  async function code(cookie: string, over: { challenge?: string } = {}) {
    const response = await auth.handler(
      new Request(
        `${origin}/api/auth/electron/transfer-user?client_id=openbot-desktop&state=${state}&code_challenge=${over.challenge ?? challenge}`,
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { electron_authorization_code: string })
      .electron_authorization_code;
  }
  const exchange = (body: Record<string, string>) =>
    auth.handler(
      new Request(`${origin}/api/auth/electron/token`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const whoIs = async (cookie: string) =>
    (await (
      await auth.handler(
        new Request(`${origin}/api/auth/get-session`, {
          headers: { cookie },
        }),
      )
    ).json()) as { user?: { email: string } } | null;

  test("the app ends up with a session of its own for the same person", async () => {
    const browser = await browserSession();
    const granted = await exchange({
      token: await code(browser),
      state,
      code_verifier: verifier,
    });
    expect(granted.status).toBe(200);
    // What the shell's web view receives: a cookie it can send from then on.
    const appCookie = granted.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(appCookie).toContain("session_token");
    expect(appCookie).not.toBe(browser);
    expect((await whoIs(appCookie))?.user?.email).toBe(
      (await whoIs(browser))?.user?.email as string,
    );
  });

  test("another app that read the code out of the address cannot use it without the secret", async () => {
    const stolen = await code(await browserSession());
    for (const attempt of [
      { token: stolen, state, code_verifier: "w".repeat(43) },
      { token: stolen, state: "x".repeat(24), code_verifier: verifier },
    ]) {
      const refused = await exchange(attempt);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
  });

  test("a code works once", async () => {
    const token = await code(await browserSession());
    expect(
      (await exchange({ token, state, code_verifier: verifier })).status,
    ).toBe(200);
    const again = await exchange({ token, state, code_verifier: verifier });
    expect(again.status).toBe(404);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  test("somebody who is not signed in is given no code", async () => {
    const response = await auth.handler(
      new Request(
        `${origin}/api/auth/electron/transfer-user?client_id=openbot-desktop&state=${state}&code_challenge=${challenge}`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(response.status).toBe(401);
  });
});
