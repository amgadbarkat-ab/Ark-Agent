import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export function connect(
  databaseUrl: string,
  options: { schema?: string } = {},
): Sql {
  return postgres(databaseUrl, {
    onnotice: () => {},
    ...(options.schema ? { connection: { search_path: options.schema } } : {}),
  });
}

/** Applies every migration not yet recorded, in filename order, each in its own transaction. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`
    create table if not exists hub_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from hub_migrations`).map(
      (row) => row.name,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into hub_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}

const DATABASE_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Creates the hub's database if it does not exist yet. Returns whether it had to.
 *
 * So a first start needs one setting, not a setup step: point `HUB_DATABASE_URL` at a server and the
 * hub makes its own database there. It does so through the server's maintenance database, which
 * needs the right to create databases; on a managed server that withholds it, say so and let the
 * operator create the database once.
 */
export async function ensureDatabase(databaseUrl: string): Promise<boolean> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!DATABASE_NAME.test(name)) {
    throw new Error(
      `The hub's database name must be letters, digits and underscores, but is "${name}".`,
    );
  }
  url.pathname = "/postgres";
  const admin = connect(url.toString());
  try {
    const found =
      await admin`select 1 from pg_database where datname = ${name}`;
    if (found.length > 0) return false;
    try {
      await admin.unsafe(`create database "${name}"`);
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "42P04") return false; // another process created it first
      if (code === "42501") {
        throw new Error(
          `The hub's database "${name}" does not exist and this login may not create it. Create it once with: CREATE DATABASE ${name};`,
        );
      }
      throw error;
    }
  } finally {
    await admin.end();
  }
}
