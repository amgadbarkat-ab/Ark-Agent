/**
 * The board's storage on a local SQLite file, through `bun:sqlite` (part of Bun): the stand-in for
 * D1 in the tests and in `dev.ts`. Never deployed; the Worker uses `d1Sql`.
 */
import { Database } from "bun:sqlite";
import type { Param, Sql } from "./sql";
import { migrate } from "./store";

export function sqliteSql(db: Database): Sql & { close(): void } {
  return {
    async first<T>(query: string, ...params: Param[]) {
      return (db.query(query).get(...params) as T | null) ?? null;
    },
    async all<T>(query: string, ...params: Param[]) {
      return db.query(query).all(...params) as T[];
    },
    async run(query: string, ...params: Param[]) {
      const result = db.query(query).run(...params);
      return {
        changes: result.changes,
        lastRowId: Number(result.lastInsertRowid),
      };
    },
    async batch(statements) {
      db.transaction(() => {
        for (const [query, ...params] of statements)
          db.query(query).run(...params);
      })();
    },
    close: () => db.close(),
  };
}

/** A fresh local store with the board's schema, for tests and `dev.ts`. */
export async function openLocalStore(path: string) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  const sql = sqliteSql(db);
  await migrate(sql);
  return sql;
}
