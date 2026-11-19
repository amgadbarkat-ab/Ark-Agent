/**
 * The board's storage: one small async SQL interface. On Cloudflare it is D1 (`d1Sql`); in the
 * tests and `dev.ts` it is a local SQLite file through `bun:sqlite` (`sqliteSql`, in
 * sql-sqlite.ts), so the tests need no new package. Only positional `?` parameters are used.
 */
import type { D1Database } from "./workers";

export type Param = string | number | null;

export type RunResult = { changes: number; lastRowId: number };

export interface Sql {
  first<T>(query: string, ...params: Param[]): Promise<T | null>;
  all<T>(query: string, ...params: Param[]): Promise<T[]>;
  run(query: string, ...params: Param[]): Promise<RunResult>;
  /** Several statements, all or none (D1's batch is a transaction). */
  batch(statements: Array<[string, ...Param[]]>): Promise<void>;
}

export function d1Sql(db: D1Database): Sql {
  const bind = (query: string, params: Param[]) =>
    db.prepare(query).bind(...params);
  return {
    first: <T>(query: string, ...params: Param[]) =>
      bind(query, params).first<T>(),
    async all<T>(query: string, ...params: Param[]) {
      return (await bind(query, params).all<T>()).results;
    },
    async run(query, ...params) {
      const result = await bind(query, params).run();
      return {
        changes: result.meta.changes ?? 0,
        lastRowId: result.meta.last_row_id ?? 0,
      };
    },
    async batch(statements) {
      await db.batch(
        statements.map(([query, ...params]) => bind(query, params)),
      );
    },
  };
}

/** Whether an error is a UNIQUE or PRIMARY KEY clash (both SQLite and D1 say so in the message). */
export function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message)
  );
}
