import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAudit, verifyAudit } from "./audit";
import { openLocalStore } from "./sql-sqlite";

const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
async function store() {
  const dir = mkdtempSync(join(tmpdir(), "control-board-audit-"));
  dirs.push(dir);
  const sql = await openLocalStore(join(dir, "board.sqlite"));
  stores.push(sql);
  return sql;
}
afterEach(() => {
  for (const one of stores.splice(0)) one.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse("2026-11-18T10:00:00Z");
const entry = (target: string) => ({
  actor: "maria",
  action: "view",
  target,
  outcome: "ok" as const,
});

test("entries come back newest first, as written, and the chain holds", async () => {
  const sql = await store();
  await appendAudit(
    sql,
    {
      actor: "maria",
      role: "support",
      action: "sign-in",
      target: "maria",
      outcome: "ok",
    },
    T,
  );
  await appendAudit(sql, entry("customer:demo-shop"), T + 1000);
  expect(
    (await readAudit(sql, 10, 0)).map((row) => [
      row.id,
      row.action,
      row.target,
      row.at,
    ]),
  ).toEqual([
    [2, "view", "customer:demo-shop", "2026-11-18T10:00:01.000Z"],
    [1, "sign-in", "maria", "2026-11-18T10:00:00.000Z"],
  ]);
  expect(await verifyAudit(sql)).toBe(null);
});

test("entries written at the same moment all land, in one unbroken chain", async () => {
  const sql = await store();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => appendAudit(sql, entry(`p${i}`), T)),
  );
  expect((await readAudit(sql, 100, 0)).length).toBe(20);
  expect(await verifyAudit(sql)).toBe(null);
});

test("two isolates writing at once (two connections to one database) keep one unbroken chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "control-board-audit-"));
  dirs.push(dir);
  const one = await openLocalStore(join(dir, "board.sqlite"));
  const two = await openLocalStore(join(dir, "board.sqlite"));
  stores.push(one, two);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      appendAudit(i % 2 ? one : two, entry(`p${i}`), T),
    ),
  );
  expect((await readAudit(one, 100, 0)).length).toBe(10);
  expect(await verifyAudit(two)).toBe(null);
});

test("an entry cannot be changed or removed (the database refuses)", async () => {
  const sql = await store();
  await appendAudit(
    sql,
    {
      actor: "maria",
      action: "sign-in",
      target: "maria",
      outcome: "refused",
      detail: "code",
    },
    T,
  );
  await expect(
    sql.run("UPDATE audit SET outcome = 'ok' WHERE id = 1"),
  ).rejects.toThrow("append-only");
  await expect(sql.run("DELETE FROM audit")).rejects.toThrow("append-only");
  expect((await readAudit(sql, 10, 0))[0]).toMatchObject({
    outcome: "refused",
    detail: "code",
  });
});

test("a change, or a removal, made with the protection taken off shows as a broken chain", async () => {
  const sql = await store();
  for (let i = 0; i < 4; i++) await appendAudit(sql, entry(`page-${i}`), T + i);
  await sql.run("DROP TRIGGER audit_no_update");
  await sql.run("UPDATE audit SET actor = 'someone-else' WHERE id = 3");
  expect(await verifyAudit(sql)).toBe(3);
  const other = await store();
  for (let i = 0; i < 4; i++)
    await appendAudit(other, entry(`page-${i}`), T + i);
  await other.run("DROP TRIGGER audit_no_delete");
  await other.run("DELETE FROM audit WHERE id = 2");
  expect(await verifyAudit(other)).toBe(3);
});
