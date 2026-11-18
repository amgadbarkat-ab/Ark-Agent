import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRow, appendAudit, GENESIS, rowHash } from "./audit";
import {
  type AuditBatch,
  blackarkCopy,
  checkChain,
  copyAudit,
  NIGHTLY,
  nightly,
  r2Copy,
  signCopy,
} from "./cron";
import { readSnapshot } from "./snapshots";
import { openLocalStore } from "./sql-sqlite";
import type { R2Bucket } from "./workers";

const T = Date.parse("2026-11-18T02:17:00Z");
const SECRET = "audit-copy-secret-for-tests-0123456789";
const dirs: string[] = [];
const stores: Array<{ close(): void }> = [];
const saved = { ...NIGHTLY };
afterEach(() => {
  Object.assign(NIGHTLY, saved);
  for (const one of stores.splice(0)) one.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function store(entries = 0) {
  const dir = mkdtempSync(join(tmpdir(), "control-board-cron-"));
  dirs.push(dir);
  const sql = await openLocalStore(join(dir, "board.sqlite"));
  stores.push(sql);
  for (let i = 0; i < entries; i++) {
    await appendAudit(
      sql,
      {
        actor: "maria",
        role: "support",
        action: "view",
        target: `customer:c${i}`,
        outcome: "ok",
      },
      T + i,
    );
  }
  return sql;
}

describe("the nightly chain check, bounded for a cron's 10 ms of CPU", () => {
  test("checks new entries a stretch a night, and remembers how far it got", async () => {
    NIGHTLY.newEntries = 4;
    NIGHTLY.olderEntries = 2;
    const sql = await store(10);
    expect(await checkChain(sql, T)).toMatchObject({
      brokenAt: null,
      verified: { id: 4 },
    });
    expect((await checkChain(sql, T)).verified.id).toBe(8);
    expect((await checkChain(sql, T)).verified.id).toBe(10);
  });

  test("a new entry changed behind the board's back is found, and stays shown", async () => {
    const sql = await store(5);
    await checkChain(sql, T);
    await appendAudit(
      sql,
      { actor: "x", action: "view", target: "y", outcome: "ok" },
      T,
    );
    await sql.run("DROP TRIGGER audit_no_update");
    await sql.run("UPDATE audit SET target = 'hidden' WHERE id = 6");
    expect((await checkChain(sql, T)).brokenAt).toBe(6);
    expect((await checkChain(sql, T)).brokenAt).toBe(6);
    expect(
      (await readSnapshot<{ brokenAt: number }>(sql, "audit-chain")).value
        ?.brokenAt,
    ).toBe(6);
  });

  test("an old entry changed later is found by the rolling re-check", async () => {
    NIGHTLY.olderEntries = 3;
    const sql = await store(9);
    await checkChain(sql, T);
    await sql.run("DROP TRIGGER audit_no_update");
    await sql.run("UPDATE audit SET actor = 'someone-else' WHERE id = 2");
    const found: Array<number | null> = [];
    for (let night = 0; night < 3; night++)
      found.push((await checkChain(sql, T)).brokenAt);
    // The first night re-checked 1-3; then 4-6, 7-9, and from the start again.
    expect(found).toEqual([null, null, 2]);
  });
});

/** A stand-in for blackark.uk's checkin/audit-copy/: checks like the PHP endpoint, keeps the chain. */
function fakeBlackark(options: { down?: boolean; unsigned?: boolean } = {}) {
  const kept: AuditRow[] = [];
  const seen: AuditBatch[] = [];
  const answer: typeof fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;
    if (
      signCopy(
        SECRET,
        headers["x-ark-time"] ?? "",
        headers["x-ark-nonce"] ?? "",
        body,
      ) !== headers["x-ark-signature"]
    ) {
      return new Response("{}", { status: 403 });
    }
    if (options.down) return new Response("{}", { status: 503 });
    const batch = JSON.parse(body) as AuditBatch;
    seen.push(batch);
    let prev = batch.prevHash;
    if (prev !== (kept.at(-1)?.hash ?? GENESIS))
      return new Response("{}", { status: 409 });
    for (const row of batch.entries) {
      if (row.prev_hash !== prev || rowHash(prev, row) !== row.hash)
        return new Response("{}", { status: 409 });
      kept.push(row);
      prev = row.hash;
    }
    const answer = JSON.stringify({
      stored: batch.entries.length,
      lastId: kept.at(-1)?.id ?? null,
    });
    const time = String(Math.floor(T / 1000));
    return new Response(answer, {
      headers: {
        "x-ark-time": time,
        "x-ark-signature": options.unsigned
          ? "0".repeat(64)
          : signCopy(SECRET, time, headers["x-ark-nonce"] ?? "", answer),
      },
    });
  }) as unknown as typeof fetch;
  return { fetch: answer, kept, seen };
}

describe("the off-site audit copy", () => {
  test("blackark: signed batches that continue the copy; the next night sends only what is new", async () => {
    NIGHTLY.copied = 3;
    const sql = await store(5);
    const site = fakeBlackark();
    const copy = blackarkCopy({
      url: "https://blackark.example/checkin/audit-copy/",
      secret: SECRET,
      fetch: site.fetch,
    });
    expect(await copyAudit(sql, copy, T)).toBe(3);
    expect(await copyAudit(sql, copy, T)).toBe(2);
    expect(await copyAudit(sql, copy, T)).toBe(0);
    expect(site.kept.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(site.seen[1]?.prevHash).toBe(site.kept[2]?.hash);
  });

  test("blackark: a refused or unsigned answer is not counted as copied; the next night sends it again", async () => {
    const sql = await store(2);
    const logs: string[] = [];
    await nightly(
      sql,
      blackarkCopy({
        url: "https://x.example/",
        secret: SECRET,
        fetch: fakeBlackark({ down: true }).fetch,
      }),
      () => T,
      (line) => logs.push(line),
    );
    expect(logs).toEqual([
      "control-board: the audit copy to blackark failed: The audit copy answered 503.",
    ]);
    await expect(
      copyAudit(
        sql,
        blackarkCopy({
          url: "https://x.example/",
          secret: SECRET,
          fetch: fakeBlackark({ unsigned: true }).fetch,
        }),
        T,
      ),
    ).rejects.toThrow("not signed");
    await expect(
      copyAudit(
        sql,
        blackarkCopy({
          url: "https://x.example/",
          secret: "another-secret-0123456789abcdefghij",
          fetch: fakeBlackark().fetch,
        }),
        T,
      ),
    ).rejects.toThrow("answered 403");
    const site = fakeBlackark();
    expect(
      await copyAudit(
        sql,
        blackarkCopy({
          url: "https://x.example/",
          secret: SECRET,
          fetch: site.fetch,
        }),
        T,
      ),
    ).toBe(2);
    expect(site.kept.map((row) => row.id)).toEqual([1, 2]);
  });

  test("r2: one object per night, named by day and ids, with the chain's starting hash", async () => {
    const sql = await store(3);
    const objects = new Map<string, string>();
    const bucket: R2Bucket = {
      put: async (key: string, value: string) => void objects.set(key, value),
    } as unknown as R2Bucket;
    expect(await copyAudit(sql, r2Copy(bucket), T)).toBe(3);
    await appendAudit(
      sql,
      { actor: "maria", action: "view", target: "audit", outcome: "ok" },
      T,
    );
    expect(await copyAudit(sql, r2Copy(bucket), T)).toBe(1);
    expect([...objects.keys()]).toEqual([
      "audit/2026-11-18-1-3.json",
      "audit/2026-11-18-4-4.json",
    ]);
    const second = JSON.parse(
      objects.get("audit/2026-11-18-4-4.json") as string,
    ) as AuditBatch;
    const first = JSON.parse(
      objects.get("audit/2026-11-18-1-3.json") as string,
    ) as AuditBatch;
    expect(second.prevHash).toBe(first.entries.at(-1)?.hash as string);
  });
});
