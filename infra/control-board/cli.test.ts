import { afterEach, expect, test } from "bun:test";
import { type Io, runCli } from "./cli";
import { SCHEMA } from "./store";
import {
  Browser,
  START,
  type TestBoard,
  testBoard,
  VirtualAuthenticator,
} from "./test-helpers";
import { totp } from "./totp";

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function terminal() {
  let out = "";
  const err: string[] = [];
  const io: Io = {
    out: (text) => (out += text),
    err: (line) => err.push(line),
  };
  return { io, out: () => out, err };
}

function cli(args: string[]) {
  const term = terminal();
  const code = runCli(args, term.io, {
    now: () => START,
    publicOrigin: "https://board.example",
  });
  return { code, sql: term.out(), err: term.err.join("\n") };
}

/** What `wrangler d1 execute --command` does with the printed SQL. */
async function execute(t: TestBoard, sql: string) {
  for (const statement of sql
    .split(";\n")
    .map((s) => s.trim())
    .filter(Boolean))
    await t.sql.run(statement);
}

const linkPath = (err: string) =>
  err.match(/https:\/\/board\.example(\/setup\/[A-Za-z0-9_-]{43})/)?.[1] ?? "";

async function finishSetup(
  t: TestBoard,
  path: string,
  passkey = new VirtualAuthenticator(),
) {
  const browser = t.browser();
  const form = await browser.get(path);
  const secret = form.text.match(/secret=([A-Z2-7]+)/)?.[1] ?? "";
  const done = await browser.passkeyForm(
    `${path}/options`,
    path,
    Browser.csrfFrom(form.text),
    (pk) => passkey.register(pk),
    {
      code: totp(secret, t.clock.now),
    },
  );
  return { done, secret, passkey, browser };
}

test("schema: one statement per line, the same tables the board makes", () => {
  const { code, sql } = cli(["schema"]);
  expect(code).toBe(0);
  expect(sql.trim().split("\n")).toHaveLength(SCHEMA.length);
  expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS audit_no_update");
});

test("owner: SQL to stdout with no token in it, the link to stderr; the owner sets up and signs in", async () => {
  const t = await testBoard();
  current = t;
  const { code, sql, err } = cli(["owner", "First.Owner"]);
  expect(code).toBe(0);
  const path = linkPath(err);
  expect(path).not.toBe("");
  expect(sql).not.toContain(path.slice("/setup/".length));
  await execute(t, sql);
  const { done, secret, passkey, browser } = await finishSetup(t, path);
  expect(done.text).toContain("Setup is done");
  t.clock.now += 30_000;
  expect(
    (await browser.signIn("first.owner", totp(secret, t.clock.now), passkey))
      .status,
  ).toBe(303);
  expect((await browser.get("/accounts")).status).toBe(200);
});

test("owner does nothing once an active owner exists", async () => {
  const t = await testBoard();
  current = t;
  await t.addAccount("boss", "owner");
  const { sql, err } = cli(["owner", "intruder"]);
  await execute(t, sql);
  expect(
    await t.sql.first("SELECT id FROM accounts WHERE username = 'intruder'"),
  ).toBe(null);
  expect((await t.browser().get(linkPath(err))).status).toBe(404);
});

test("owner with an Access email stores it; bad names and emails are refused before any SQL", async () => {
  const t = await testBoard();
  current = t;
  await execute(t, cli(["owner", "maria", "Maria@BlackArk.example"]).sql);
  expect(
    await t.sql.first<{ access_email: string }>(
      "SELECT access_email FROM accounts WHERE username = 'maria'",
    ),
  ).toEqual({
    access_email: "maria@blackark.example",
  });
  for (const args of [
    ["owner", "x'; DROP TABLE accounts; --"],
    ["owner", "ok", "not-an-email"],
    ["reset"],
    ["what"],
  ]) {
    const result = cli(args);
    expect(result.code).toBe(1);
    expect(result.sql).toBe("");
  }
});

test("reset: the old passkey and sessions stop working, a new link sets the account up again", async () => {
  const t = await testBoard();
  current = t;
  await t.addAccount("boss", "owner");
  const old = t.browser();
  await old.signIn("boss", t.code("boss"));
  expect((await old.get("/")).status).toBe(200);
  const { sql, err } = cli(["reset", "boss"]);
  await execute(t, sql);
  expect((await old.get("/")).status).toBe(303);
  t.clock.now += 30_000;
  expect((await t.browser().signIn("boss", t.code("boss"))).status).not.toBe(
    303,
  );
  const { done } = await finishSetup(t, linkPath(err));
  expect(done.text).toContain("Setup is done");
});

test("unlock: clears that account's failures only", async () => {
  const t = await testBoard();
  current = t;
  await t.addAccount("boss", "owner");
  const id = (
    await t.sql.first<{ id: number }>(
      "SELECT id FROM accounts WHERE username = 'boss'",
    )
  )?.id;
  await t.sql.run(
    "INSERT INTO login_failures (key, at) VALUES (?, ?), ('ip:abc', ?)",
    `account:${id}`,
    START,
    START,
  );
  await execute(t, cli(["unlock", "boss"]).sql);
  expect(await t.sql.all("SELECT key FROM login_failures")).toEqual([
    { key: "ip:abc" },
  ]);
});
