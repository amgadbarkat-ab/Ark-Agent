import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, ensureDatabase } from "../src/db";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL must point at a dedicated PostgreSQL test database.",
  );
}

const created: string[] = [];
const urlFor = (name: string) => {
  const url = new URL(testUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

afterAll(async () => {
  const admin = connect(urlFor("postgres"));
  for (const name of created) {
    await admin.unsafe(`drop database if exists "${name}"`);
  }
  await admin.end();
});

describe("ensureDatabase", () => {
  test("creates a missing database once and leaves an existing one alone", async () => {
    const name = `hub_ensure_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    created.push(name);
    expect(await ensureDatabase(urlFor(name))).toBe(true);
    expect(await ensureDatabase(urlFor(name))).toBe(false);

    const sql = connect(urlFor(name));
    expect((await sql`select 1 as ok`)[0]?.ok).toBe(1);
    await sql.end();
  });

  test("refuses a name that is not plain letters, digits and underscores", async () => {
    await expect(
      ensureDatabase(urlFor('x"; drop database postgres; --')),
    ).rejects.toThrow(/letters, digits and underscores/);
  });
});
