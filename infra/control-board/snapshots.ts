/**
 * The sources, fetched by the Cron Trigger and kept in D1, one row each, so a page reads one row
 * and never fetches anything itself (a page must stay inside the Worker's 10 ms of CPU).
 *
 * - `checkins`: blackark.uk's export, parsed and checked in the cron, stored as compact JSON;
 * - `relay`: the relay's health; `issues`: GitHub; `billing`: Stripe (null: not connected);
 * - `audit-chain`: the nightly check of the audit log's chain.
 *
 * A source that fails keeps its last good answer, with the error and when it was last asked.
 */
import type { Sql } from "./sql";

export type Snapshot<T> = {
  value: T | null;
  fetchedAt: number | null;
  error?: string;
  checkedAt: number | null;
  ms?: number;
};

export async function readSnapshot<T>(
  sql: Sql,
  source: string,
): Promise<Snapshot<T>> {
  const row = await sql.first<{
    body: string | null;
    fetched_at: number | null;
    error: string | null;
    checked_at: number;
    ms: number | null;
  }>(
    "SELECT body, fetched_at, error, checked_at, ms FROM snapshots WHERE source = ?",
    source,
  );
  if (!row) return { value: null, fetchedAt: null, checkedAt: null };
  return {
    value: row.body === null ? null : (JSON.parse(row.body) as T),
    fetchedAt: row.fetched_at,
    ...(row.error ? { error: row.error } : {}),
    checkedAt: row.checked_at,
    ...(row.ms !== null ? { ms: row.ms } : {}),
  };
}

/** Stores a source's new answer. */
export async function saveSnapshot(
  sql: Sql,
  source: string,
  value: unknown,
  now: number,
  ms?: number,
) {
  await sql.run(
    `INSERT INTO snapshots (source, body, fetched_at, error, checked_at, ms) VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT (source) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at, error = NULL,
       checked_at = excluded.checked_at, ms = excluded.ms`,
    source,
    JSON.stringify(value ?? null),
    now,
    now,
    ms ?? null,
  );
}

/** Records that a source failed, keeping its last good answer. */
export async function saveFailure(
  sql: Sql,
  source: string,
  error: string,
  now: number,
) {
  await sql.run(
    `INSERT INTO snapshots (source, body, fetched_at, error, checked_at, ms) VALUES (?, NULL, NULL, ?, ?, NULL)
     ON CONFLICT (source) DO UPDATE SET error = excluded.error, checked_at = excluded.checked_at`,
    source,
    error.slice(0, 300),
    now,
  );
}
