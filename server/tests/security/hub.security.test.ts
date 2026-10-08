import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { joinCodeFor, signJoinToken } from "../../../hub/src/tokens";
import { testDatabaseUrl } from "../support/database";
import { SECURITY_ENABLED } from "./harness";

/**
 * The conversation service, attacked the way a browser on the internet could.
 *
 * A browser holds a short-lived token that names one conversation. Everything here is a way to read
 * somebody else's conversation, or to act as the application's own server, with less than that.
 * The hub's REST API and runner socket are for this deployment's server alone, and are protected by
 * a key; the browser's socket by a token. Each is tried without, with a wrong one, with an expired
 * one, and with a good one for the wrong thing.
 *
 *   OPENBOT_SECURITY=1 bun run test:security
 */

const run = SECURITY_ENABLED ? describe : describe.skip;

const API_KEY = "hub-api-key-for-the-security-test-0000";
const JOIN_SECRET = "hub-join-secret-for-the-security-test-00";
let stop: () => Promise<void>;
let port = 0;

beforeAll(async () => {
  if (!SECURITY_ENABLED) return;
  const base = new URL(testDatabaseUrl());
  const name = `ark_hub_sec_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const owner = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await owner.unsafe(`create database ${name}`);
  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${name}`;

  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = probe.port as number;
  await probe.stop(true);

  const hub = Bun.spawn(["bun", "--no-env-file", "hub/src/index.ts"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      HUB_PORT: String(port),
      HUB_DATABASE_URL: databaseUrl.toString(),
      HUB_API_KEY: API_KEY,
      HUB_JOIN_SECRET: JOIN_SECRET,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) break;
    } catch {
      await Bun.sleep(250);
    }
  }
  stop = async () => {
    hub.kill();
    await hub.exited;
    await owner.unsafe(`drop database if exists ${name} with (force)`);
    await owner.end({ timeout: 5 });
  };
}, 60_000);

afterAll(async () => {
  if (stop) await stop();
});

const http = (path: string, init: RequestInit = {}) =>
  fetch(`http://localhost:${port}${path}`, { ...init, keepalive: false });

/** What the hub says to a request to open a socket, before any socket exists: 401 for a stranger. */
async function handshake(path: string, protocols = "phoenix"): Promise<number> {
  const answer = await http(path, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...(protocols ? { "sec-websocket-protocol": protocols } : {}),
    },
  });
  return answer.status;
}

/** What a Phoenix socket answers to a join: `ok:`, `error:<reason>`, or the way it never got that far. */
async function joinOutcome(path: string, topic: string): Promise<string> {
  const probe = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      new URL("./ws-probe.ts", import.meta.url).pathname,
      `ws://127.0.0.1:${port}${path}`,
      topic,
      "phoenix",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const outcome = (await new Response(probe.stdout).text()).trim();
  await probe.exited;
  return outcome;
}

run("the conversation service", () => {
  test("its HTTP API answers nobody without the server's key", async () => {
    for (const path of [
      "/api/entitlements/runtime",
      "/api/threads",
      "/api/threads/00000000-0000-4000-8000-000000000000",
      "/connector/anything",
    ]) {
      for (const headers of [
        {},
        { authorization: "Bearer guess" },
        { authorization: `bearer ${API_KEY}` },
        { authorization: API_KEY },
        { authorization: `Bearer ${API_KEY} x` },
        { "x-api-key": API_KEY },
      ]) {
        const answer = await http(path, { headers });
        expect([path, JSON.stringify(headers), answer.status]).toEqual([
          path,
          JSON.stringify(headers),
          401,
        ]);
      }
    }
    expect((await http("/health")).status).toBe(200);
  });

  test("a browser socket needs a token this hub signed, for now", async () => {
    const scope = { kind: "thread", threadId: "t-1", userId: "u-1" } as const;
    const now = Date.now();
    const bad = [
      "",
      "garbage",
      "a.b",
      signJoinToken("some-other-secret-that-is-long-enough-00", scope, 3600),
      signJoinToken(JOIN_SECRET, scope, 3600, now - 7_200_000),
      `${signJoinToken(JOIN_SECRET, scope, 3600).split(".")[0]}.AAAA`,
    ];
    for (const token of bad) {
      const status = await handshake(
        `/client/websocket?join_token=${encodeURIComponent(token)}`,
      );
      expect([token.slice(0, 12), status]).toEqual([token.slice(0, 12), 401]);
    }
    expect(await handshake("/client/websocket")).toBe(401);
  });

  test("a token for one conversation joins that one and nothing else", async () => {
    const token = signJoinToken(
      JOIN_SECRET,
      { kind: "thread", threadId: "mine", userId: "u-1" },
      3600,
    );
    const path = `/client/websocket?join_token=${encodeURIComponent(token)}`;
    expect(await joinOutcome(path, "thread:mine")).toBe("ok:");
    expect(await joinOutcome(path, "thread:theirs")).toBe("error:unauthorized");
    expect(await joinOutcome(path, "thread:mine/../theirs")).toBe(
      "error:unauthorized",
    );
    expect(await joinOutcome(path, "thread:")).toBe("error:unauthorized");
    // A person's list of conversations is only theirs.
    expect(
      await joinOutcome(path, `user_meta:${joinCodeFor(JOIN_SECRET, "u-2")}`),
    ).toMatch(/^error:/);
  });

  test("a person's thread-list token joins their list and no other, and no conversation", async () => {
    const token = signJoinToken(
      JOIN_SECRET,
      { kind: "meta", userId: "u-1" },
      3600,
    );
    const path = `/client/websocket?join_token=${encodeURIComponent(token)}`;
    expect(
      await joinOutcome(path, `user_meta:${joinCodeFor(JOIN_SECRET, "u-1")}`),
    ).toBe("ok:");
    expect(
      await joinOutcome(path, `user_meta:${joinCodeFor(JOIN_SECRET, "u-2")}`),
    ).toBe("error:unauthorized");
    expect(await joinOutcome(path, "thread:mine")).toBe("error:unauthorized");
  });

  test("the runner's socket, which writes conversations, answers only the server's key", async () => {
    const asProtocol = (secret: string) =>
      `phoenix, base64url.bearer.phx.${Buffer.from(secret).toString("base64url")}`;
    for (const protocols of [
      "phoenix",
      "phoenix, guess",
      asProtocol("guess"),
      asProtocol(`${API_KEY}x`),
      asProtocol(""),
      "",
    ]) {
      expect([
        protocols,
        await handshake("/runner/websocket", protocols),
      ]).toEqual([protocols, 401]);
    }
    // A browser's token is not the server's key.
    const token = signJoinToken(
      JOIN_SECRET,
      { kind: "thread", threadId: "mine", userId: "u-1" },
      3600,
    );
    expect(await handshake("/runner/websocket", asProtocol(token))).toBe(401);
    // And the key itself is let through, so that the refusals above mean something.
    expect(await handshake("/runner/websocket", asProtocol(API_KEY))).not.toBe(
      401,
    );
  });

  test("hostile input to its API is refused politely, never with its insides", async () => {
    for (const raw of ["{", "[]", "null", "x".repeat(2_000_000)]) {
      const answer = await http("/api/threads", {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: raw,
      });
      expect(answer.status).toBeLessThan(500);
      expect(await answer.text()).not.toMatch(
        /at .*\.ts:\d+|node_modules|postgres:\/\//,
      );
    }
  });
});
