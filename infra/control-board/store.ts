/**
 * The board's own tables, in D1 (SQLite). It keeps only what the board needs:
 * - staff accounts and how each signs in;
 * - sessions, setup links and sign-in challenges;
 * - recent sign-in failures and the audit log;
 * - support cases;
 * - the latest snapshot of each source, fetched by the Cron Trigger.
 *
 * No passwords: the first factor is Cloudflare Access or a passkey, and the second is always the
 * board's TOTP.
 *
 * `migrate` is idempotent (CREATE … IF NOT EXISTS). On Cloudflare the same statements run once,
 * from `schema.sql` (written by `bun cli.ts schema`), through `wrangler d1 execute`.
 */
import type { Sql } from "./sql";

export const ROLES = ["owner", "admin", "support", "read-only"] as const;
export type Role = (typeof ROLES)[number];

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'support', 'read-only')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    access_email TEXT UNIQUE COLLATE NOCASE,
    totp_secret TEXT,
    totp_last_step INTEGER NOT NULL DEFAULT -1,
    created_at TEXT NOT NULL,
    created_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    algorithm INTEGER NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'sign-in')),
    challenge TEXT NOT NULL,
    account_id INTEGER,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS setup_links (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    totp_secret TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // "name:<user>" or "ip:<sha-256 of the address>", for 15 minutes.
  `CREATE TABLE IF NOT EXISTS login_failures (
    key TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS login_failures_key ON login_failures (key, at)",
  // The audit log: append-only. The board never issues UPDATE or DELETE on it, and the triggers
  // refuse both; each row carries the SHA-256 of the one before, so a changed row shows.
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT,
    role TEXT,
    action TEXT NOT NULL,
    target TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused')),
    detail TEXT,
    prev_hash TEXT NOT NULL UNIQUE,
    hash TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END`,
  // How far the off-site copy of the audit log has got.
  `CREATE TABLE IF NOT EXISTS audit_copies (
    destination TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL,
    last_hash TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  // The latest answer of each source, written by the Cron Trigger and read by the pages.
  `CREATE TABLE IF NOT EXISTS snapshots (
    source TEXT PRIMARY KEY,
    body TEXT,
    fetched_at INTEGER,
    error TEXT,
    checked_at INTEGER NOT NULL,
    ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS cases (
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('in-app', 'email')),
    language TEXT NOT NULL CHECK (language IN ('el', 'en')),
    priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal')),
    plan TEXT NOT NULL CHECK (plan IN ('trial', 'paid')),
    status TEXT NOT NULL CHECK (status IN ('new', 'open', 'waiting', 'solved', 'closed')),
    subject TEXT NOT NULL,
    owner TEXT,
    github_issue INTEGER,
    sla_due_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source_ref TEXT UNIQUE
  )`,
  "CREATE INDEX IF NOT EXISTS cases_customer ON cases (customer_id, number)",
  `CREATE TABLE IF NOT EXISTS case_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number INTEGER NOT NULL REFERENCES cases (number),
    at TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS case_notes_no_update BEFORE UPDATE ON case_notes
    BEGIN SELECT RAISE(ABORT, 'Notes are kept as written.'); END`,
  `CREATE TRIGGER IF NOT EXISTS case_notes_no_delete BEFORE DELETE ON case_notes
    BEGIN SELECT RAISE(ABORT, 'Notes are kept as written.'); END`,
  `CREATE TABLE IF NOT EXISTS intake_nonces (
    nonce TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  )`,
  // How a case's customer can be answered (replies.ts): the install it came from, for the app, and
  // an email address, for mail. New tables, so a running board needs no table rebuilt.
  `CREATE TABLE IF NOT EXISTS case_reach (
    case_number INTEGER PRIMARY KEY REFERENCES cases (number),
    install_id TEXT,
    email TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS case_reach_install ON case_reach (install_id)",
  `CREATE TABLE IF NOT EXISTS case_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number INTEGER NOT NULL REFERENCES cases (number),
    at TEXT NOT NULL,
    author TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('el', 'en')),
    body TEXT NOT NULL,
    english TEXT,
    emailed_to TEXT,
    email TEXT NOT NULL CHECK (email IN ('sent', 'failed', 'none'))
  )`,
  "CREATE INDEX IF NOT EXISTS case_replies_case ON case_replies (case_number, id)",
  `CREATE TRIGGER IF NOT EXISTS case_replies_no_update BEFORE UPDATE ON case_replies
    BEGIN SELECT RAISE(ABORT, 'Replies are kept as sent.'); END`,
  `CREATE TRIGGER IF NOT EXISTS case_replies_no_delete BEFORE DELETE ON case_replies
    BEGIN SELECT RAISE(ABORT, 'Replies are kept as sent.'); END`,
];

export async function migrate(sql: Sql): Promise<void> {
  for (const statement of SCHEMA) await sql.run(statement);
}

/** The schema as one file for `wrangler d1 execute --file`. */
export function schemaFile(): string {
  return `${SCHEMA.map((statement) => `${statement.replace(/\s+/g, " ").trim()};`).join("\n")}\n`;
}
