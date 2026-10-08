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
