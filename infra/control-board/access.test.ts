import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { cloudflareAccess } from "./access";
import { START, type TestBoard, testBoard } from "./test-helpers";

const TEAM = "blackark-test.cloudflareaccess.com";
const AUD = "aud-tag-for-tests-0123456789";
const NOW = START;

const team = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(publicKey: KeyObject, kid: string) {
  return {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
}

function token(
  claims: Record<string, unknown>,
  options: { key?: KeyObject; kid?: string; alg?: string } = {},
) {
  const head = Buffer.from(
    JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      aud: [AUD],
      iss: `https://${TEAM}`,
      exp: NOW / 1000 + 600,
      iat: NOW / 1000,
      email: "Maria@BlackArk.example",
      ...claims,
    }),
  ).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    options.key ?? team.privateKey,
  ).toString("base64url");
  return `${head}.${body}.${signature}`;
}

let certCalls = 0;
const certs = (async (url: string) => {
  certCalls += 1;
  expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk(team.publicKey, "k1")] });
}) as unknown as typeof fetch;

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function board() {
  current = await testBoard(undefined, {
    firstFactor: "access",
    access: cloudflareAccess({
      teamDomain: TEAM,
      aud: AUD,
      fetch: certs,
      now: () => NOW,
    }),
  });
  await current.addAccount("maria", "support", "maria@blackark.example");
  return current.board;
}

const get = (path: string, assertion?: string) =>
  new Request(
    `https://board.example${path}`,
    assertion ? { headers: { "cf-access-jwt-assertion": assertion } } : {},
  );

describe("Cloudflare Access's signed header", () => {
  test("a request through Access reaches the board, named by its email (then the board's TOTP applies)", async () => {
    const answer = await (await board()).fetch(get("/login", token({})));
    expect(answer.status).toBe(200);
    const page = await answer.text();
    expect(page).toContain('name="code"');
    expect(page).toContain("<strong>maria</strong>");
  });

  test("the email comes back lower-cased; a token with no email has no account", async () => {
    const check = cloudflareAccess({
      teamDomain: TEAM,
      aud: AUD,
      fetch: certs,
      now: () => NOW,
    });
    expect(await check(get("/", token({})))).toEqual({
      ok: true,
      email: "maria@blackark.example",
    });
    expect(await check(get("/", token({ email: undefined })))).toEqual({
      ok: true,
      email: null,
    });
    expect(
      (
        await (
          await board()
        ).fetch(get("/login", token({ email: "guest@blackark.example" })))
      ).status,
    ).toBe(403);
  });

  test("a request around the tunnel, or with a bad assertion, gets nothing", async () => {
    const b = await board();
    const refused = [
      undefined,
      "not.a.jwt",
      token({ aud: ["another-app"] }),
      token({ iss: "https://someone-else.cloudflareaccess.com" }),
      token({ exp: NOW / 1000 - 120 }),
      token({ iat: NOW / 1000 + 600, nbf: NOW / 1000 + 600 }),
      token({}, { key: stranger.privateKey }),
      token({}, { kid: "unknown" }),
      token({}, { alg: "HS256" }),
    ];
    for (const assertion of refused) {
      const answer = await b.fetch(get("/login", assertion));
      expect(answer.status).toBe(403);
      expect(await answer.text()).toBe("Not through Cloudflare Access.");
    }
  });

  test("The health check and the signed intake are not behind Access", async () => {
    const b = await board();
    expect((await b.fetch(get("/healthz"))).status).toBe(200);
    // No intake extension here, so it falls through to the sign-in redirect, not to a 403.
    expect((await b.fetch(get("/intake/app"))).status).toBe(303);
  });

  test("the team's keys are fetched once an hour, not per request", async () => {
    certCalls = 0;
    const b = await board();
    for (let i = 0; i < 5; i++) await b.fetch(get("/login", token({})));
    expect(certCalls).toBe(1);
  });
});
