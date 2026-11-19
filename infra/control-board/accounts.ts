/**
 * Staff accounts, sign-in and sessions. No passwords (argon2id cannot fit in a Worker's 10 ms):
 * - FIRST FACTOR, one of (board.ts, `FIRST_FACTOR`):
 *   - `access`: Cloudflare Access let the person through, and the email in its signed header
 *     belongs to this account;
 *   - `passkey`: a passkey registered to this account signed our challenge (webauthn.ts).
 * - SECOND FACTOR, always: a TOTP code (RFC 6238), taken once. The same code, or an older one,
 *   cannot sign in again.
 * - After 5 failures for one account (or one address: 20) in 15 minutes, signing in is refused
 *   until the 15 minutes pass.
 * - A session ends after 15 minutes without a request, and after 8 hours in any case. Only the
 *   SHA-256 of its token is stored. Each session has its own CSRF token.
 * - A new account, or a reset one, gets a one-time setup link valid 24 hours, where the person adds
 *   the TOTP key (and, with passkeys, registers a passkey).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Sql } from "./sql";
import { ROLES, type Role } from "./store";
import { newTotpSecret, verifyTotp } from "./totp";
import type { StoredPasskey } from "./webauthn";

export const IDLE_MS = 15 * 60_000;
export const MAX_SESSION_MS = 8 * 60 * 60_000;
export const LOCK_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES = 5;
export const MAX_ADDRESS_FAILURES = 20;
export const SETUP_LINK_MS = 24 * 60 * 60_000;
export const CHALLENGE_MS = 5 * 60_000;

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export type Account = {
  id: number;
  username: string;
  role: Role;
  status: "pending" | "active" | "disabled";
  access_email: string | null;
  totp_secret: string | null;
  totp_last_step: number;
  created_at: string;
  created_by: string | null;
};

export type Session = { account: Account; csrf: string; tokenHash: string };

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validUsername(name: string): boolean {
  return USERNAME.test(name);
}

export function validEmail(email: string): boolean {
  return EMAIL.test(email);
}

export function validRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

export function findAccount(
  sql: Sql,
  username: string,
): Promise<Account | null> {
  return sql.first<Account>(
    "SELECT * FROM accounts WHERE username = ?",
    username,
  );
}

export function findAccountById(sql: Sql, id: number): Promise<Account | null> {
  return sql.first<Account>("SELECT * FROM accounts WHERE id = ?", id);
}

export function findAccountByEmail(
  sql: Sql,
  email: string,
): Promise<Account | null> {
  return sql.first<Account>(
    "SELECT * FROM accounts WHERE access_email = ?",
    email.toLowerCase(),
  );
}

export function listAccounts(sql: Sql): Promise<Account[]> {
  return sql.all<Account>("SELECT * FROM accounts ORDER BY username");
}

export async function activeOwners(sql: Sql): Promise<number> {
  return (
    (
      await sql.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner' AND status = 'active'",
      )
    )?.n ?? 0
  );
}

/** A new account, not yet usable, and its one-time setup link token (shown once). */
export async function createPendingAccount(
  sql: Sql,
  input: { username: string; role: Role; accessEmail?: string | null },
  createdBy: string | null,
  now: number,
): Promise<string> {
  if (!validUsername(input.username)) throw new Error("bad-username");
  if (input.accessEmail && !validEmail(input.accessEmail))
    throw new Error("bad-email");
  if (await findAccount(sql, input.username)) throw new Error("taken");
  if (input.accessEmail && (await findAccountByEmail(sql, input.accessEmail)))
    throw new Error("email-taken");
  const result = await sql.run(
    "INSERT INTO accounts (username, role, status, access_email, created_at, created_by) VALUES (?, ?, 'pending', ?, ?, ?)",
    input.username,
    input.role,
    input.accessEmail?.toLowerCase() ?? null,
    new Date(now).toISOString(),
    createdBy,
  );
  return newSetupLink(sql, result.lastRowId, now);
}

/** Ends every session, removes the 2FA and the passkeys, and gives a new setup link. */
export async function resetAccount(
  sql: Sql,
  account: Account,
  now: number,
): Promise<string> {
  await sql.batch([
    [
      "UPDATE accounts SET status = 'pending', totp_secret = NULL, totp_last_step = -1 WHERE id = ?",
      account.id,
    ],
    ["DELETE FROM passkeys WHERE account_id = ?", account.id],
    ["DELETE FROM sessions WHERE account_id = ?", account.id],
  ]);
  return newSetupLink(sql, account.id, now);
}

export async function disableAccount(
  sql: Sql,
  account: Account,
): Promise<void> {
  await sql.batch([
    ["UPDATE accounts SET status = 'disabled' WHERE id = ?", account.id],
    ["DELETE FROM setup_links WHERE account_id = ?", account.id],
    ["DELETE FROM sessions WHERE account_id = ?", account.id],
  ]);
}

async function newSetupLink(
  sql: Sql,
  accountId: number,
  now: number,
): Promise<string> {
  const token = newToken();
  await sql.batch([
    ["DELETE FROM setup_links WHERE account_id = ?", accountId],
    [
      "INSERT INTO setup_links (token_hash, account_id, totp_secret, expires_at) VALUES (?, ?, ?, ?)",
      sha256(token),
      accountId,
      newTotpSecret(),
      now + SETUP_LINK_MS,
    ],
  ]);
  return token;
}

export type SetupLink = { account: Account; totpSecret: string };

export async function findSetupLink(
  sql: Sql,
  token: string,
  now: number,
): Promise<SetupLink | null> {
  const row = await sql.first<{
    account_id: number;
    totp_secret: string;
    expires_at: number;
  }>(
    "SELECT account_id, totp_secret, expires_at FROM setup_links WHERE token_hash = ?",
    sha256(token),
  );
  if (!row || row.expires_at < now) return null;
  const account = await findAccountById(sql, row.account_id);
  if (account?.status !== "pending") return null;
  return { account, totpSecret: row.totp_secret };
}

export type SetupResult =
  | { ok: true; account: Account }
  | { ok: false; reason: "link" | "code" | "passkey" };

/** Finishes a setup link: the first TOTP code, and (with passkeys) the passkey just registered. */
export async function completeSetup(
  sql: Sql,
  token: string,
  code: string,
  now: number,
  passkey: StoredPasskey | null,
  needsPasskey: boolean,
): Promise<SetupResult> {
  const link = await findSetupLink(sql, token, now);
  if (!link) return { ok: false, reason: "link" };
  if (needsPasskey && !passkey) return { ok: false, reason: "passkey" };
  const step = verifyTotp(link.totpSecret, code.trim(), now);
  if (step === null) return { ok: false, reason: "code" };
  const statements: Array<[string, ...(string | number | null)[]]> = [
    [
      "UPDATE accounts SET status = 'active', totp_secret = ?, totp_last_step = ? WHERE id = ?",
      link.totpSecret,
      step,
      link.account.id,
    ],
    ["DELETE FROM setup_links WHERE account_id = ?", link.account.id],
  ];
  if (passkey) {
    statements.push([
      "INSERT INTO passkeys (credential_id, account_id, public_key, algorithm, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      passkey.credentialId,
      link.account.id,
      JSON.stringify(passkey.publicKey),
      passkey.algorithm,
      passkey.signCount,
      new Date(now).toISOString(),
    ]);
  }
  await sql.batch(statements);
  return { ok: true, account: { ...link.account, status: "active" } };
}

// ---- Passkeys and challenges -------------------------------------------------------------------

export async function findPasskey(
  sql: Sql,
  credentialId: string,
): Promise<(StoredPasskey & { accountId: number }) | null> {
  const row = await sql.first<{
    credential_id: string;
    account_id: number;
    public_key: string;
    algorithm: -7 | -257;
    sign_count: number;
  }>("SELECT * FROM passkeys WHERE credential_id = ?", credentialId);
  return row
    ? {
        credentialId: row.credential_id,
        accountId: row.account_id,
        publicKey: JSON.parse(row.public_key),
        algorithm: row.algorithm,
        signCount: row.sign_count,
      }
    : null;
}

export async function setSignCount(
  sql: Sql,
  credentialId: string,
  count: number,
): Promise<void> {
  await sql.run(
    "UPDATE passkeys SET sign_count = ? WHERE credential_id = ?",
    count,
    credentialId,
  );
}

export async function newChallenge(
  sql: Sql,
  purpose: "register" | "sign-in",
  accountId: number | null,
  challenge: string,
  now: number,
): Promise<string> {
  const id = newToken();
  await sql.run("DELETE FROM challenges WHERE expires_at < ?", now);
  await sql.run(
    "INSERT INTO challenges (id, purpose, challenge, account_id, expires_at) VALUES (?, ?, ?, ?, ?)",
    id,
    purpose,
    challenge,
    accountId,
    now + CHALLENGE_MS,
  );
  return id;
}

/** A challenge, once: it is removed as it is read. */
export async function takeChallenge(
  sql: Sql,
  id: string,
  purpose: "register" | "sign-in",
  now: number,
): Promise<{ challenge: string; accountId: number | null } | null> {
  const row = await sql.first<{
    challenge: string;
    account_id: number | null;
    expires_at: number;
    purpose: string;
  }>("SELECT * FROM challenges WHERE id = ?", id);
  if (!row) return null;
  const taken = await sql.run("DELETE FROM challenges WHERE id = ?", id);
  if (taken.changes === 0 || row.purpose !== purpose || row.expires_at < now)
    return null;
  return { challenge: row.challenge, accountId: row.account_id };
}

// ---- Failures, TOTP and sessions ---------------------------------------------------------------

export async function failures(
  sql: Sql,
  key: string,
  now: number,
): Promise<number> {
  await sql.run(
    "DELETE FROM login_failures WHERE at < ?",
    now - LOCK_WINDOW_MS,
  );
  return (
    (
      await sql.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM login_failures WHERE key = ?",
        key,
      )
    )?.n ?? 0
  );
}

export async function recordFailure(
  sql: Sql,
  keys: string[],
  now: number,
): Promise<void> {
  await sql.batch(
    keys.map((key) => [
      "INSERT INTO login_failures (key, at) VALUES (?, ?)",
      key,
      now,
    ]),
  );
}

export async function clearFailures(sql: Sql, key: string): Promise<void> {
  await sql.run("DELETE FROM login_failures WHERE key = ?", key);
}

/** The second factor: a TOTP code newer than the last one used. Opens a session when it fits. */
export async function finishSignIn(
  sql: Sql,
  account: Account,
  code: string,
  now: number,
): Promise<{ token: string; csrf: string } | null> {
  if (account.status !== "active" || !account.totp_secret) return null;
  const step = verifyTotp(
    account.totp_secret,
    code.trim(),
    now,
    account.totp_last_step,
  );
  if (step === null) return null;
  // Taken once: only one request can move the step past this value.
  const moved = await sql.run(
    "UPDATE accounts SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?",
    step,
    account.id,
    step,
  );
  if (moved.changes === 0) return null;
  const token = newToken();
  const csrf = newToken();
  await sql.run(
    "INSERT INTO sessions (token_hash, account_id, csrf, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
    sha256(token),
    account.id,
    csrf,
    now,
    now,
  );
  return { token, csrf };
}

/** The session for a cookie token, kept alive by this request; null when absent or expired. */
export async function findSession(
  sql: Sql,
  token: string,
  now: number,
): Promise<Session | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = await sql.first<{
    account_id: number;
    csrf: string;
    created_at: number;
    last_seen: number;
  }>(
    "SELECT account_id, csrf, created_at, last_seen FROM sessions WHERE token_hash = ?",
    tokenHash,
  );
  if (!row) return null;
  const account =
    now - row.last_seen > IDLE_MS || now - row.created_at > MAX_SESSION_MS
      ? null
      : await findAccountById(sql, row.account_id);
  if (account?.status !== "active") {
    await sql.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    return null;
  }
  // At most once a minute, so a page of requests is not a page of writes.
  if (now - row.last_seen > 60_000) {
    await sql.run(
      "UPDATE sessions SET last_seen = ? WHERE token_hash = ?",
      now,
      tokenHash,
    );
  }
  return { account, csrf: row.csrf, tokenHash };
}

export async function endSession(sql: Sql, tokenHash: string): Promise<void> {
  await sql.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
}

export async function pruneExpired(sql: Sql, now: number): Promise<void> {
  await sql.batch([
    [
      "DELETE FROM sessions WHERE last_seen < ? OR created_at < ?",
      now - IDLE_MS,
      now - MAX_SESSION_MS,
    ],
    ["DELETE FROM setup_links WHERE expires_at < ?", now],
    ["DELETE FROM challenges WHERE expires_at < ?", now],
    ["DELETE FROM login_failures WHERE at < ?", now - LOCK_WINDOW_MS],
  ]);
}

// ---- The address key, for the per-address sign-in limit ----------------------------------------

const salts = new WeakMap<Sql, string>();

/**
 * The key a caller's address is counted under: HMAC-SHA256 of the address with a random salt made
 * once and kept in D1, so the stored key cannot be turned back into the address by trying every
 * IPv4 address. Kept 15 minutes, like the failures it counts.
 */
export async function addressKey(
  sql: Sql,
  ip: string,
  now: number,
): Promise<string> {
  let salt = salts.get(sql);
  if (!salt) {
    await sql.run(
      "INSERT OR IGNORE INTO snapshots (source, body, fetched_at, checked_at) VALUES ('address-salt', ?, ?, ?)",
      JSON.stringify(randomBytes(32).toString("hex")),
      now,
      now,
    );
    const row = await sql.first<{ body: string }>(
      "SELECT body FROM snapshots WHERE source = 'address-salt'",
    );
    salt = JSON.parse(row?.body ?? '""') as string;
    salts.set(sql, salt);
  }
  return `ip:${createHmac("sha256", salt).update(ip).digest("hex")}`;
}
