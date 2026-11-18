/**
 * The append-only audit log: every sign-in (and every refused one), every sign-out, every page of
 * customer data opened and every change. Rows are never changed or removed (SQLite triggers), and
 * each carries the hash of the one before, so `verifyAudit` finds a row changed behind its back.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

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

const GENESIS = "0".repeat(64);

function rowHash(prev: string, row: Omit<AuditRow, "prev_hash" | "hash">) {
  return createHash("sha256")
    .update(
      `${prev}\n${JSON.stringify([row.id, row.at, row.actor, row.role, row.action, row.target, row.outcome, row.detail])}`,
    )
    .digest("hex");
}

export function appendAudit(db: Database, entry: AuditEntry, now: number) {
  db.transaction(() => {
    const last = db
      .query<{ id: number; hash: string }, []>(
        "SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1",
      )
      .get();
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
    db.query(
      `INSERT INTO audit (id, at, actor, role, action, target, outcome, detail, prev_hash, hash)
       VALUES ($id, $at, $actor, $role, $action, $target, $outcome, $detail, $prev, $hash)`,
    ).run({ ...row, prev, hash: rowHash(prev, row) });
  })();
}

export function readAudit(
  db: Database,
  limit: number,
  offset: number,
): AuditRow[] {
  return db
    .query<AuditRow, [number, number]>(
      "SELECT * FROM audit ORDER BY id DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset);
}

export function countAudit(db: Database): number {
  return (
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit").get()?.n ?? 0
  );
}

/** The first row whose hash does not follow from the one before it, or null when the chain holds. */
export function verifyAudit(db: Database): number | null {
  let prev = GENESIS;
  let expectedId = 1;
  for (const row of db
    .query<AuditRow, []>("SELECT * FROM audit ORDER BY id")
    .iterate()) {
    if (
      row.id !== expectedId ||
      row.prev_hash !== prev ||
      rowHash(prev, row) !== row.hash
    ) {
      return row.id;
    }
    prev = row.hash;
    expectedId += 1;
  }
  return null;
}
