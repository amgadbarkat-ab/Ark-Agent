/**
 * Staff accounts, sign-in and sessions.
 *
 * - One account per person, never a shared password. A role each: owner, admin, support, read-only.
 * - A sign-in needs the password (argon2id, Bun.password) AND a TOTP code (RFC 6238) every time. A
 *   code is taken once: the same code, or an older one, cannot sign in again.
 * - After 5 failures for one name in 15 minutes, that name cannot sign in until the 15 minutes
 *   pass, whatever is typed. Unknown names are counted too, so the answer never tells which exist.
 * - A session ends after 15 minutes without a request, and after 8 hours in any case. Only the
 *   SHA-256 of its token is stored. Each session has its own CSRF token.
 * - A new account, or one whose password and 2FA are reset, gets a one-time setup link valid for
 *   24 hours. The person chooses the password and adds the TOTP secret there.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { ROLES, type Role } from "./store";
import { newTotpSecret, verifyTotp } from "./totp";

export const IDLE_MS = 15 * 60_000;
export const MAX_SESSION_MS = 8 * 60 * 60_000;
export const LOCK_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES = 5;
export const SETUP_LINK_MS = 24 * 60 * 60_000;
export const MIN_PASSWORD = 12;

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export type Account = {
  id: number;
  username: string;
  role: Role;
  status: "pending" | "active" | "disabled";
  password_hash: string | null;
  totp_secret: string | null;
  totp_last_step: number;
  created_at: string;
  created_by: string | null;
};

export type Session = {
  account: Account;
  csrf: string;
  tokenHash: string;
};

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export const argon2id: PasswordHasher = {
  hash: (password) => Bun.password.hash(password, { algorithm: "argon2id" }),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validUsername(name: string): boolean {
  return USERNAME.test(name);
}

export function validRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

export function findAccount(db: Database, username: string): Account | null {
  return db
    .query<Account, [string]>("SELECT * FROM accounts WHERE username = ?")
    .get(username);
}

export function listAccounts(db: Database): Account[] {
  return db
    .query<Account, []>("SELECT * FROM accounts ORDER BY username")
    .all();
}

export function activeOwners(db: Database): number {
  return (
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner' AND status = 'active'",
      )
      .get()?.n ?? 0
  );
}

/** A new account with no password yet, and its one-time setup link token (shown once). */
export function createPendingAccount(
  db: Database,
  username: string,
  role: Role,
  createdBy: string | null,
  now: number,
): string {
  if (!validUsername(username)) throw new Error("bad-username");
  if (findAccount(db, username)) throw new Error("taken");
  const result = db
    .query(
      "INSERT INTO accounts (username, role, status, created_at, created_by) VALUES (?, ?, 'pending', ?, ?)",
    )
    .run(username, role, new Date(now).toISOString(), createdBy);
  return newSetupLink(db, Number(result.lastInsertRowid), now);
}

/** Ends every session, clears the password and 2FA, and gives a new setup link. */
export function resetAccount(db: Database, account: Account, now: number) {
  db.query(
    "UPDATE accounts SET status = 'pending', password_hash = NULL, totp_secret = NULL, totp_last_step = -1 WHERE id = ?",
  ).run(account.id);
  endSessions(db, account.id);
  return newSetupLink(db, account.id, now);
}

export function disableAccount(db: Database, account: Account) {
  db.query("UPDATE accounts SET status = 'disabled' WHERE id = ?").run(
    account.id,
  );
  db.query("DELETE FROM setup_links WHERE account_id = ?").run(account.id);
  endSessions(db, account.id);
}

function newSetupLink(db: Database, accountId: number, now: number): string {
  const token = newToken();
  db.query("DELETE FROM setup_links WHERE account_id = ?").run(accountId);
  db.query(
    "INSERT INTO setup_links (token_hash, account_id, totp_secret, expires_at) VALUES (?, ?, ?, ?)",
  ).run(sha256(token), accountId, newTotpSecret(), now + SETUP_LINK_MS);
  return token;
}

export type SetupLink = { account: Account; totpSecret: string };

export function findSetupLink(
  db: Database,
  token: string,
  now: number,
): SetupLink | null {
  const row = db
    .query<
      { account_id: number; totp_secret: string; expires_at: number },
      [string]
    >(
      "SELECT account_id, totp_secret, expires_at FROM setup_links WHERE token_hash = ?",
    )
    .get(sha256(token));
  if (!row || row.expires_at < now) return null;
  const account = db
    .query<Account, [number]>("SELECT * FROM accounts WHERE id = ?")
    .get(row.account_id);
  if (account?.status !== "pending") return null;
  return { account, totpSecret: row.totp_secret };
}

export type SetupResult =
  | { ok: true; account: Account }
  | {
      ok: false;
      reason: "link" | "password-short" | "password-mismatch" | "code";
    };

/** Finishes a setup link: the password (twice) and a first TOTP code from the person's app. */
export async function completeSetup(
  db: Database,
  token: string,
  password: string,
  repeat: string,
  code: string,
  now: number,
  hasher: PasswordHasher = argon2id,
): Promise<SetupResult> {
  const link = findSetupLink(db, token, now);
  if (!link) return { ok: false, reason: "link" };
  if (password.length < MIN_PASSWORD)
    return { ok: false, reason: "password-short" };
  if (password !== repeat) return { ok: false, reason: "password-mismatch" };
  const step = verifyTotp(link.totpSecret, code, now);
  if (step === null) return { ok: false, reason: "code" };
  const hash = await hasher.hash(password);
  db.query(
    "UPDATE accounts SET status = 'active', password_hash = ?, totp_secret = ?, totp_last_step = ? WHERE id = ?",
  ).run(hash, link.totpSecret, step, link.account.id);
  db.query("DELETE FROM setup_links WHERE account_id = ?").run(link.account.id);
  return { ok: true, account: { ...link.account, status: "active" } };
}

/** For the CLI: sets the password and 2FA of a new account directly (the first owner). */
export async function activateDirectly(
  db: Database,
  username: string,
  role: Role,
  password: string,
  totpSecret: string,
  step: number,
  now: number,
  hasher: PasswordHasher = argon2id,
) {
  if (!validUsername(username)) throw new Error("bad-username");
  if (findAccount(db, username)) throw new Error("taken");
  db.query(
    "INSERT INTO accounts (username, role, status, password_hash, totp_secret, totp_last_step, created_at, created_by) VALUES (?, ?, 'active', ?, ?, ?, ?, 'cli')",
  ).run(
    username,
    role,
    await hasher.hash(password),
    totpSecret,
    step,
    new Date(now).toISOString(),
  );
}

// A hash of a random password, verified against when the name is unknown, so a wrong name takes
// as long as a wrong password.
let decoy: Promise<string> | null = null;

export type SignInResult =
  | { ok: true; account: Account; token: string; csrf: string }
  | {
      ok: false;
      reason: "locked" | "unknown" | "disabled" | "password" | "code";
    };

export async function signIn(
  db: Database,
  username: string,
  password: string,
  code: string,
  now: number,
  hasher: PasswordHasher = argon2id,
): Promise<SignInResult> {
  const name = username.trim().toLowerCase().slice(0, 64);
  db.query("DELETE FROM login_failures WHERE at < ?").run(now - LOCK_WINDOW_MS);
  const failures =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM login_failures WHERE username = ?",
      )
      .get(name)?.n ?? 0;
  if (failures >= MAX_FAILURES) return { ok: false, reason: "locked" };

  const fail = (reason: "unknown" | "disabled" | "password" | "code") => {
    db.query("INSERT INTO login_failures (username, at) VALUES (?, ?)").run(
      name,
      now,
    );
    return { ok: false as const, reason };
  };
  const account = validUsername(name) ? findAccount(db, name) : null;
  if (!account?.password_hash || !account.totp_secret) {
    decoy ??= hasher.hash(newToken());
    await hasher.verify(password, await decoy);
    return fail(account ? "disabled" : "unknown");
  }
  const passwordOk = await hasher.verify(password, account.password_hash);
  if (!passwordOk) return fail("password");
  if (account.status !== "active") return fail("disabled");
  const step = verifyTotp(
    account.totp_secret,
    code.trim(),
    now,
    account.totp_last_step,
  );
  if (step === null) return fail("code");

  db.query("UPDATE accounts SET totp_last_step = ? WHERE id = ?").run(
    step,
    account.id,
  );
  db.query("DELETE FROM login_failures WHERE username = ?").run(name);
  const token = newToken();
  const csrf = newToken();
  db.query(
    "INSERT INTO sessions (token_hash, account_id, csrf, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
  ).run(sha256(token), account.id, csrf, now, now);
  return { ok: true, account, token, csrf };
}

/** The session for a cookie token, kept alive by this request; null when absent or expired. */
export function findSession(
  db: Database,
  token: string,
  now: number,
): Session | null {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db
    .query<
      {
        account_id: number;
        csrf: string;
        created_at: number;
        last_seen: number;
      },
      [string]
    >(
      "SELECT account_id, csrf, created_at, last_seen FROM sessions WHERE token_hash = ?",
    )
    .get(tokenHash);
  if (!row) return null;
  if (now - row.last_seen > IDLE_MS || now - row.created_at > MAX_SESSION_MS) {
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  const account = db
    .query<Account, [number]>("SELECT * FROM accounts WHERE id = ?")
    .get(row.account_id);
  if (account?.status !== "active") {
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  db.query("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(
    now,
    tokenHash,
  );
  return { account, csrf: row.csrf, tokenHash };
}

export function endSession(db: Database, tokenHash: string) {
  db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function endSessions(db: Database, accountId: number) {
  db.query("DELETE FROM sessions WHERE account_id = ?").run(accountId);
}

export function pruneSessions(db: Database, now: number) {
  db.query("DELETE FROM sessions WHERE last_seen < ? OR created_at < ?").run(
    now - IDLE_MS,
    now - MAX_SESSION_MS,
  );
  db.query("DELETE FROM setup_links WHERE expires_at < ?").run(now);
}
