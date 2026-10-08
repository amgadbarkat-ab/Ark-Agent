import { randomUUID } from "node:crypto";
import { connect, migrate, type Sql } from "../src/db";

export interface TestDatabase {
  sql: Sql;
  databaseUrl: string;
  schema: string;
  drop(): Promise<void>;
}

/**
 * A private schema in the dedicated test database, migrated and ready.
 *
 * Every test file gets its own, so files can run in any order and a failed one leaves nothing
 * behind that the next would trip over.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL must point at a dedicated PostgreSQL test database.",
    );
  }
  const schema = `hub_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = connect(databaseUrl);
  await admin.unsafe(`create schema "${schema}"`);
  await admin.end();
  const sql = connect(databaseUrl, { schema });
  await migrate(sql);
  return {
    sql,
    databaseUrl,
    schema,
    async drop() {
      await sql.end();
      const cleanup = connect(databaseUrl);
      await cleanup.unsafe(`drop schema "${schema}" cascade`);
      await cleanup.end();
    },
  };
}
