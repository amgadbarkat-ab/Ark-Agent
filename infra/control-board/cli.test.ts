import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIn } from "./accounts";
import { readAudit } from "./audit";
import { type Io, runCli } from "./cli";
import { openStore } from "./store";
import { fastHasher } from "./test-helpers";
import { totp } from "./totp";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "control-board-cli-"));
  dirs.push(dir);
  return openStore(join(dir, "board.sqlite"));
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A terminal that answers from a script; `hidden` records which prompts hid what was typed. */
function terminal(answers: Array<string | ((printed: string[]) => string)>) {
  const printed: string[] = [];
  const hidden: string[] = [];
  const next = () => {
    const answer = answers.shift();
    return typeof answer === "function" ? answer(printed) : (answer ?? "");
  };
  const io: Io = {
    ask: async () => next(),
    askHidden: async (question) => {
      hidden.push(question);
      return next();
    },
    print: (line) => printed.push(line),
  };
  return { io, printed, hidden };
}

const secretFrom = (printed: string[]) =>
  printed.join("\n").match(/secret=([A-Z2-7]+)/)?.[1] ?? "";

test("create-owner: the password only at hidden prompts, then the first 2FA code; the owner can sign in", async () => {
  const db = store();
  const term = terminal([
    "First.Owner",
    "a long owner password",
    "a long owner password",
    (printed) => totp(secretFrom(printed), NOW),
  ]);
  expect(
    await runCli(["create-owner"], db, term.io, {
      now: () => NOW,
      hasher: fastHasher,
    }),
  ).toBe(0);
  expect(term.hidden).toHaveLength(2);
  expect(term.printed.join("\n")).not.toContain("a long owner password");
  const secret = secretFrom(term.printed);
  const later = NOW + 30_000;
  const result = await signIn(
    db,
    "first.owner",
    "a long owner password",
    totp(secret, later),
    later,
    fastHasher,
  );
  expect(result.ok).toBe(true);
  expect(readAudit(db, 1, 0)[0]).toMatchObject({
    actor: "cli",
    action: "account.create",
    target: "first.owner",
    outcome: "ok",
  });
});

test("create-owner refuses a wrong first code, and a second owner", async () => {
  const db = store();
  const wrong = terminal([
    "boss",
    "a long owner password",
    "a long owner password",
    "000000",
  ]);
  expect(
    await runCli(["create-owner"], db, wrong.io, {
      now: () => NOW,
      hasher: fastHasher,
    }),
  ).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({
    n: 0,
  });
  const ok = terminal([
    "boss",
    "a long owner password",
    "a long owner password",
    (printed) => totp(secretFrom(printed), NOW),
  ]);
  expect(
    await runCli(["create-owner"], db, ok.io, {
      now: () => NOW,
      hasher: fastHasher,
    }),
  ).toBe(0);
  const again = terminal(["other"]);
  expect(
    await runCli(["create-owner"], db, again.io, {
      now: () => NOW,
      hasher: fastHasher,
    }),
  ).toBe(1);
});

test("reset prints a setup link once; verify-audit reports the chain", async () => {
  const db = store();
  const ok = terminal([
    "boss",
    "a long owner password",
    "a long owner password",
    (printed) => totp(secretFrom(printed), NOW),
  ]);
  await runCli(["create-owner"], db, ok.io, {
    now: () => NOW,
    hasher: fastHasher,
  });
  const reset = terminal([]);
  expect(
    await runCli(["reset", "boss"], db, reset.io, {
      now: () => NOW,
      publicOrigin: "https://board.example",
    }),
  ).toBe(0);
  expect(reset.printed.join("\n")).toMatch(
    /https:\/\/board\.example\/setup\/[A-Za-z0-9_-]{43}/,
  );
  expect(
    db.query("SELECT status FROM accounts WHERE username = 'boss'").get(),
  ).toEqual({ status: "pending" });
  const verify = terminal([]);
  expect(await runCli(["verify-audit"], db, verify.io)).toBe(0);
  expect(verify.printed).toEqual(["The audit log is intact."]);
});
