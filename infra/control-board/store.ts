/**
 * The board's own SQLite file (`bun:sqlite`, part of Bun). It keeps only what the board itself
 * needs: staff accounts, their sessions and setup links, recent sign-in failures, the audit log,
 * and (milestone 2) support cases. No customer data is copied here from the sources.
 */
import { Database } from "bun:sqlite";

export const ROLES = ["owner", "admin", "support", "read-only"] as const;
export type Role = (typeof ROLES)[number];

export function openStore(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'support', 'read-only')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
    password_hash TEXT,
    totp_secret TEXT,
    totp_last_step INTEGER NOT NULL DEFAULT -1,
    created_at TEXT NOT NULL,
    created_by TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS setup_links (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    totp_secret TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS login_failures (
    username TEXT NOT NULL COLLATE NOCASE,
    at INTEGER NOT NULL
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS login_failures_username ON login_failures (username, at)",
  );
  // The audit log: append-only. SQLite refuses any change or removal of a row, and each row carries
  // the SHA-256 of the one before it, so a row changed with the triggers taken off shows.
  db.exec(`CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT,
    role TEXT,
    action TEXT NOT NULL,
    target TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused')),
    detail TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END`);
  // Support cases (milestone 2).
  db.exec(`CREATE TABLE IF NOT EXISTS cases (
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
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS cases_customer ON cases (customer_id, number)",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS case_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number INTEGER NOT NULL REFERENCES cases (number),
    at TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS case_notes_no_update BEFORE UPDATE ON case_notes
    BEGIN SELECT RAISE(ABORT, 'Notes are kept as written.'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS case_notes_no_delete BEFORE DELETE ON case_notes
    BEGIN SELECT RAISE(ABORT, 'Notes are kept as written.'); END`);
  db.exec(`CREATE TABLE IF NOT EXISTS intake_nonces (
    nonce TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  )`);
  return db;
}
