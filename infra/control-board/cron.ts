/**
 * What the Worker's Cron Triggers do (wrangler.toml):
 * - every 10 minutes, `refreshSources`: the check-in export, the relay, GitHub and Stripe, each
 *   parsed here and stored as one snapshot row (snapshots.ts), so pages never fetch;
 * - every 5 minutes, the support mailbox (intake.ts `pollMailbox`, through Microsoft Graph in mail.ts);
 * - every night, `nightly`: the audit chain is checked, the new audit entries are copied off-site
 *   (R2, or blackark.uk's `checkin/audit-copy/`), and expired sessions and challenges are pruned.
 * Each run is one Worker invocation: at most 50 subrequests and 50 D1 queries on the free plan,
 * which these stay well under.
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pruneExpired } from "./accounts";
import {
  type AuditRow,
  auditSince,
  type ChainMark,
  GENESIS,
  START_MARK,
  verifyAuditPart,
} from "./audit";
import { readSnapshot, saveFailure, saveSnapshot } from "./snapshots";
import type { Sources } from "./sources";
import type { Sql } from "./sql";
import type { R2Bucket } from "./workers";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function refreshSources(
  sql: Sql,
  sources: Sources,
  now: () => number,
): Promise<void> {
  const timed = async (source: string, load: () => Promise<unknown>) => {
    const started = now();
    try {
      const value = await load();
      await saveSnapshot(sql, source, value, now(), now() - started);
    } catch (error) {
      await saveFailure(sql, source, message(error), now());
    }
  };
  await Promise.all([
    timed("checkins", () => sources.checkins.load()),
    timed("relay", () => sources.relay.check()),
    timed("issues", () => sources.issues.list()),
    timed("billing", () => sources.billing.snapshot()),
  ]);
}

// ---- The audit log's off-site copy -------------------------------------------------------------

export type AuditBatch = { prevHash: string; entries: AuditRow[] };

export interface AuditCopy {
  name: "r2" | "blackark";
  /** Stores a batch that continues the copy so far; throws when it is not taken. */
  send(batch: AuditBatch, now: number): Promise<void>;
}

export function signCopy(
  secret: string,
  time: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${time}.${nonce}.${body}`)
    .digest("hex");
}

/** blackark.uk's `checkin/audit-copy/`: signed like the export, kept there append-only. */
export function blackarkCopy(options: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
}): AuditCopy {
  const send = options.fetch ?? fetch;
  return {
    name: "blackark",
    async send(batch, now) {
      const body = JSON.stringify(batch);
      const time = String(Math.floor(now / 1000));
      const nonce = randomBytes(18).toString("base64url");
      const response = await send(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ark-time": time,
          "x-ark-nonce": nonce,
          "x-ark-signature": signCopy(options.secret, time, nonce, body),
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`The audit copy answered ${response.status}.`);
      // The answer is signed back for this request's nonce, as the export's is.
      const answer = await response.text();
      const answeredAt = response.headers.get("x-ark-time") ?? "";
      const expected = signCopy(options.secret, answeredAt, nonce, answer);
      const given = response.headers.get("x-ark-signature") ?? "";
      if (
        given.length !== expected.length ||
        !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
      )
        throw new Error("The audit copy's answer is not signed.");
      const stored = (JSON.parse(answer) as { lastId?: unknown }).lastId;
      if (stored !== (batch.entries.at(-1)?.id ?? null))
        throw new Error("The audit copy did not take the whole batch.");
    },
  };
}

/** One object per night in an R2 bucket (needs an R2 subscription on the account). */
export function r2Copy(bucket: R2Bucket): AuditCopy {
  return {
    name: "r2",
    async send(batch, now) {
      const first = batch.entries[0]?.id ?? 0;
      const last = batch.entries.at(-1)?.id ?? 0;
      const day = new Date(now).toISOString().slice(0, 10);
      await bucket.put(
        `audit/${day}-${first}-${last}.json`,
        JSON.stringify(batch),
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
    },
  };
}

/** Copies the entries not copied yet (at most `NIGHTLY.copied` a night), and records how far it got. */
export async function copyAudit(
  sql: Sql,
  copy: AuditCopy,
  now: number,
): Promise<number> {
  const done = await sql.first<{ last_id: number; last_hash: string }>(
    "SELECT last_id, last_hash FROM audit_copies WHERE destination = ?",
    copy.name,
  );
  const entries = await auditSince(sql, done?.last_id ?? 0, NIGHTLY.copied);
  if (entries.length === 0) return 0;
  await copy.send({ prevHash: done?.last_hash ?? GENESIS, entries }, now);
  const last = entries.at(-1) as AuditRow;
  await sql.run(
    `INSERT INTO audit_copies (destination, last_id, last_hash, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (destination) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash, at = excluded.at`,
    copy.name,
    last.id,
    last.hash,
    new Date(now).toISOString(),
  );
  return entries.length;
}

/** What the nightly chain check keeps between nights (the "audit-chain" snapshot). */
export type ChainState = {
  /** The first entry found not to follow from the one before; it stays shown once found. */
  brokenAt: number | null;
  /** Every entry up to here has been checked once. */
  verified: ChainMark;
  /** The rolling re-check of older entries is here; it starts again from the first when done. */
  rolling: ChainMark;
};

/** Per night, within a cron's 10 ms of CPU (see README, "Free plan"). */
export const NIGHTLY = { newEntries: 1000, olderEntries: 500, copied: 1000 };

export async function checkChain(sql: Sql, now: number): Promise<ChainState> {
  const before = (await readSnapshot<ChainState>(sql, "audit-chain")).value;
  const state: ChainState = {
    brokenAt: before?.brokenAt ?? null,
    verified: before?.verified ?? START_MARK,
    rolling: before?.rolling ?? START_MARK,
  };
  const fresh = await verifyAuditPart(sql, state.verified, NIGHTLY.newEntries);
  state.brokenAt ??= fresh.brokenAt;
  if (fresh.brokenAt === null) state.verified = fresh.last;
  if (state.rolling.id < state.verified.id) {
    const older = await verifyAuditPart(
      sql,
      state.rolling,
      Math.min(NIGHTLY.olderEntries, state.verified.id - state.rolling.id),
    );
    state.brokenAt ??= older.brokenAt;
    state.rolling =
      older.last.id >= state.verified.id ? START_MARK : older.last;
  } else {
    state.rolling = START_MARK;
  }
  await saveSnapshot(sql, "audit-chain", state, now);
  return state;
}

export async function nightly(
  sql: Sql,
  copy: AuditCopy | null,
  now: () => number,
  log: (line: string) => void,
) {
  await pruneExpired(sql, now());
  await checkChain(sql, now());
  if (!copy) return;
  try {
    const copied = await copyAudit(sql, copy, now());
    log(`control-board: ${copied} audit entries copied to ${copy.name}`);
  } catch (error) {
    log(
      `control-board: the audit copy to ${copy.name} failed: ${message(error)}`,
    );
    await saveFailure(sql, "audit-copy", message(error), now());
  }
}
