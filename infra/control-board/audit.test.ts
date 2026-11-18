import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAudit, verifyAudit } from "./audit";
import { openStore } from "./store";

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "control-board-audit-"));
  dirs.push(dir);
  return openStore(join(dir, "board.sqlite"));
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse("2026-11-18T10:00:00Z");

test("entries come back newest first, as written", () => {
  const db = store();
  appendAudit(
    db,
    {
      actor: "maria",
      role: "support",
      action: "sign-in",
      target: "maria",
      outcome: "ok",
    },
    T,
  );
  appendAudit(
    db,
    {
      actor: "maria",
      role: "support",
      action: "view",
      target: "customer:demo-shop",
      outcome: "ok",
    },
    T + 1000,
  );
  expect(
    readAudit(db, 10, 0).map((row) => [row.id, row.action, row.target, row.at]),
  ).toEqual([
    [2, "view", "customer:demo-shop", "2026-11-18T10:00:01.000Z"],
    [1, "sign-in", "maria", "2026-11-18T10:00:00.000Z"],
  ]);
  expect(verifyAudit(db)).toBe(null);
});

test("an entry cannot be changed or removed", () => {
  const db = store();
  appendAudit(
    db,
    {
      actor: "maria",
      action: "sign-in",
      target: "maria",
      outcome: "refused",
      detail: "code",
    },
    T,
  );
  expect(() =>
    db.query("UPDATE audit SET outcome = 'ok' WHERE id = 1").run(),
  ).toThrow("append-only");
  expect(() => db.query("DELETE FROM audit").run()).toThrow("append-only");
  expect(readAudit(db, 10, 0)[0]).toMatchObject({
    outcome: "refused",
    detail: "code",
  });
});

test("a change made with the protection taken off shows as a broken chain at that entry", () => {
  const db = store();
  for (let i = 0; i < 4; i++) {
    appendAudit(
      db,
      { actor: "maria", action: "view", target: `page-${i}`, outcome: "ok" },
      T + i,
    );
  }
  db.exec("DROP TRIGGER audit_no_update");
  db.query("UPDATE audit SET actor = 'someone-else' WHERE id = 3").run();
  expect(verifyAudit(db)).toBe(3);
});

test("a removed entry in the middle shows too", () => {
  const db = store();
  for (let i = 0; i < 4; i++) {
    appendAudit(
      db,
      { actor: "maria", action: "view", target: `page-${i}`, outcome: "ok" },
      T + i,
    );
  }
  db.exec("DROP TRIGGER audit_no_delete");
  db.query("DELETE FROM audit WHERE id = 2").run();
  expect(verifyAudit(db)).toBe(3);
});
