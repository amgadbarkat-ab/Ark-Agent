/**
 * The append-only audit log: every sign-in (and every refused one), every sign-out, every page of
 * customer data opened and every change.
 *
 * APPEND-ONLY, TWO WAYS. In code: this module is the only one that touches the table, and it only
 * INSERTs and SELECTs. In the database: triggers refuse UPDATE and DELETE (SQLite's own triggers,
 * which D1 runs as SQLite; see README). Each row carries the SHA-256 of the one before it, so
 * `verifyAudit` finds a row changed or removed behind the board's back.
 *
 * Two requests writing at once: each takes the next id explicitly; the one that loses the race on
 * the primary key (or on the unique prev_hash) reads the new last row and tries again, so the
 * chain never forks.
 */
import { createHash } from "node:crypto";
import { isConstraintError, type Sql } from "./sql";

export type AuditEntry = {
  actor: string | null;
  role?: string | null;
  action: string;
  target?: string | null;
  outcome: "ok" | "refused";
  detail?: string | null;
};

export type AuditRow = Required<AuditEntry> & {
  id: number;
  at: string;
  prev_hash: string;
  hash: string;
};

export const GENESIS = "0".repeat(64);

export function rowHash(
  prev: string,
  row: Omit<AuditRow, "prev_hash" | "hash">,
) {
  return createHash("sha256")
    .update(
      `${prev}\n${JSON.stringify([row.id, row.at, row.actor, row.role, row.action, row.target, row.outcome, row.detail])}`,
    )
    .digest("hex");
}

/** Appends in this isolate wait for each other; between isolates, the UNIQUE ids decide. */
const queues = new WeakMap<Sql, Promise<unknown>>();

export function appendAudit(
  sql: Sql,
  entry: AuditEntry,
  now: number,
): Promise<void> {
  const next = (queues.get(sql) ?? Promise.resolve()).then(
    () => appendOnce(sql, entry, now),
    () => appendOnce(sql, entry, now),
  );
  queues.set(
    sql,
    next.catch(() => {}),
  );
  return next;
}

const ATTEMPTS = 8;

async function appendOnce(
  sql: Sql,
  entry: AuditEntry,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 20 * attempt),
      );
    const last = await sql.first<{ id: number; hash: string }>(
      "SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1",
    );
    const row = {
      id: (last?.id ?? 0) + 1,
      at: new Date(now).toISOString(),
      actor: entry.actor,
      role: entry.role ?? null,
      action: entry.action,
      target: entry.target ?? null,
      outcome: entry.outcome,
      detail: entry.detail ?? null,
    };
    const prev = last?.hash ?? GENESIS;
    try {
      await sql.run(
        "INSERT INTO audit (id, at, actor, role, action, target, outcome, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.at,
        row.actor,
        row.role,
        row.action,
        row.target,
        row.outcome,
        row.detail,
        prev,
        rowHash(prev, row),
      );
      return;
    } catch (error) {
      if (!isConstraintError(error)) throw error;
    }
  }
  throw new Error("The audit log is busy; the entry was not written.");
}

export function readAudit(
  sql: Sql,
  limit: number,
  offset: number,
): Promise<AuditRow[]> {
  return sql.all<AuditRow>(
    "SELECT * FROM audit ORDER BY id DESC LIMIT ? OFFSET ?",
    limit,
    offset,
  );
}

/** Entries after `afterId`, oldest first, for the off-site copy. */
export function auditSince(
  sql: Sql,
  afterId: number,
  limit: number,
): Promise<AuditRow[]> {
  return sql.all<AuditRow>(
    "SELECT * FROM audit WHERE id > ? ORDER BY id LIMIT ?",
    afterId,
    limit,
  );
}

export async function countAudit(sql: Sql): Promise<number> {
  return (
    (await sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit"))?.n ?? 0
  );
}

/** The first row whose hash does not follow from the one before it, or null when the chain holds. */
export function brokenAt(
  rows: AuditRow[],
  prev = GENESIS,
  firstId = 1,
): number | null {
  let expectedId = firstId;
  for (const row of rows) {
    if (
      row.id !== expectedId ||
      row.prev_hash !== prev ||
      rowHash(prev, row) !== row.hash
    )
      return row.id;
    prev = row.hash;
    expectedId += 1;
  }
  return null;
}

/** Checks the whole chain, a page of 1,000 rows at a time. */
export async function verifyAudit(sql: Sql): Promise<number | null> {
  let prev = GENESIS;
  let next = 1;
  for (;;) {
    const rows = await sql.all<AuditRow>(
      "SELECT * FROM audit WHERE id >= ? ORDER BY id LIMIT 1000",
      next,
    );
    if (rows.length === 0) return null;
    const broken = brokenAt(rows, prev, next);
    if (broken !== null) return broken;
    const last = rows[rows.length - 1] as AuditRow;
    prev = last.hash;
    next = last.id + 1;
  }
}
