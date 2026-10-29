import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { approvals } from "../db/schema";

/**
 * What a digital employee wants done that waits for a person: one place, the person's "Needs you".
 *
 * Four kinds of thing arrive here. A lead asking to change a colleague's work (below). A tool call
 * the gateway held because the tool is set to ask first (`held-calls.ts`). A browser action a
 * boundary rule holds for a person (the same). And an approval card a digital employee raised in a
 * conversation, registered here so the person sees it in the same list as everything else instead of
 * only in a chat they may not have open — desk #69 was the Requests page saying "Nothing is waiting
 * for you" while a card was waiting.
 *
 * WHY THIS EXISTS. The lead of a team can read its colleagues' routines and ask them for things. What
 * it must not do alone is change or delete what a colleague was set up to do: a routine that sends a
 * weekly report is the person's decision, and a model that talked itself into "tidying up" is how it
 * quietly stops. So the lead asks, the ask lands here, and nothing changes until the owner says yes.
 *
 * THE CHANGE IS APPLIED BY THE STORE, ON APPROVAL, AND NOWHERE ELSE. Each kind has one executor,
 * registered by whoever owns the thing being changed. An approval is claimed with a conditional
 * update before its executor runs, so two people (or one person double-clicking) cannot apply it twice,
 * and a replica that dies in the middle leaves a row that says it was approved and failed rather than
 * one that says pending and may run again.
 */

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "failed";

export type ApprovalRecord = {
  id: string;
  ownerUserId: string;
  requestedByAgentId: string;
  requestedByName: string | null;
  kind: string;
  targetAgentId: string | null;
  targetAgentName: string | null;
  targetId: string | null;
  summary: string;
  payload: unknown;
  status: ApprovalStatus;
  result: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  /** Who decided, as a user id. Null until somebody has. */
  decidedBy: string | null;
  /** The conversation the ask was made in, when there was one. Where the outcome is delivered. */
  threadId: string | null;
  runId: string | null;
  /** The channel that shows `threadId`, for a link back to the conversation. */
  channelId: string | null;
};

/**
 * Applies one approved change and says what it did. A throw is a failure, with its message.
 *
 * What it returns is kept on the row (cut to a sentence's length) and handed whole to the kind's
 * `afterDecision`, which is how a tool's full answer reaches the conversation without the inbox
 * holding a copy of somebody's data.
 */
export type ApprovalExecutor = (approval: ApprovalRecord) => Promise<string>;

/**
 * What happens once a decision is final: approved and applied, approved and failed, or rejected.
 *
 * Separate from the executor because a rejection runs no executor and still has somebody waiting on
 * it: the digital employee whose call was held is told it was declined. Best-effort and after the
 * fact — the decision is already on record and a delivery that fails must not undo it.
 */
export type ApprovalAfterDecision = (
  approval: ApprovalRecord,
  outcome: { text: string | null },
) => Promise<void>;

export class ApprovalNotFoundError extends Error {
  constructor() {
    super("There is no such approval.");
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalNotPendingError extends Error {
  constructor(status: ApprovalStatus) {
    super(
      status === "expired"
        ? "This request has expired. Ask the digital employee to make it again if you still want it."
        : `This request was already ${status}.`,
    );
    this.name = "ApprovalNotPendingError";
  }
}

/** The ask itself is not acceptable. Its message is written for the digital employee that made it. */
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}

export type ApprovalInput = {
  ownerUserId: string;
  requestedByAgentId: string;
  kind: string;
  targetAgentId?: string;
  targetId?: string;
  summary: string;
  payload: unknown;
  /** The conversation and run the ask was made in, as the deployment knows them. */
  threadId?: string;
  runId?: string;
  /**
   * Makes asking twice the same ask.
   *
   * An approval card is registered by the browser that draws it, and a card is drawn again on every
   * reload; the toolCallId it belongs to is the key, so the second registration finds the first
   * rather than putting the same question in the list twice.
   */
  key?: string;
};

export type ApprovalStore = {
  request(input: ApprovalInput): Promise<ApprovalRecord>;
  /** One request, owner-scoped: somebody else's id reads as missing. */
  get(ownerUserId: string, id: string): Promise<ApprovalRecord | null>;
  /**
   * One request by id, whoever owns it, for the code that carries out an approved one.
   *
   * Not reachable from any route. The gateways read the row they are about to act on through this,
   * so what runs is what the row says rather than what a caller passed in.
   */
  find(id: string): Promise<ApprovalRecord | null>;
  /** Newest first. `pending` is what is waiting; `all` adds what was decided, for the history. */
  list(
    ownerUserId: string,
    which?: "pending" | "all",
    limit?: number,
  ): Promise<ApprovalRecord[]>;
  pendingCount(ownerUserId: string): Promise<number>;
  decide(
    ownerUserId: string,
    id: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRecord>;
};

/** How long a request waits for a person before it lapses. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How many one digital employee may have waiting at once, so a loop cannot fill somebody's inbox. */
export const MAX_PENDING_PER_AGENT = 10;
const MAX_SUMMARY = 500;

export function createApprovalStore(
  database: Database,
  options: {
    executors: Record<string, ApprovalExecutor>;
    /** Per kind, what happens once a decision is final. See {@link ApprovalAfterDecision}. */
    afterDecision?: Record<string, ApprovalAfterDecision>;
    auditStore?: AuditStore;
    now?: () => Date;
  },
): ApprovalStore {
  const { executors, auditStore } = options;
  const afterDecision = options.afterDecision ?? {};

  /** Best-effort, logged, never thrown: the decision is on record whatever happens here. */
  const settle = async (record: ApprovalRecord, text: string | null) => {
    const after = afterDecision[record.kind];
    if (!after) return;
    try {
      await after(record, { text });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "approval-after-decision-failed",
          approval: record.id,
          kind: record.kind,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const now = options.now ?? (() => new Date());

  const audit = async (
    eventType:
      | "approval.requested"
      | "approval.approved"
      | "approval.rejected"
      | "approval.failed",
    record: ApprovalRecord,
    actorUserId?: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!auditStore) return;
    await recordAuditEvent(auditStore, {
      eventType,
      targetType: "approval",
      targetId: record.id,
      ...(actorUserId ? { actorUserId } : {}),
      payload: {
        bot: record.requestedByAgentId,
        kind: record.kind,
        ...(record.targetAgentId ? { target: record.targetAgentId } : {}),
        ...(record.targetId ? { subject: record.targetId } : {}),
        ...(record.runId ? { run: record.runId } : {}),
        // Who decided and when, on the decision rows. The row's own `actorUserId` says who as well;
        // this keeps the answer in the payload an export carries.
        ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
        ...(record.decidedAt
          ? { decidedAt: record.decidedAt.toISOString() }
          : {}),
        ...extra,
      },
    });
  };

  const select = () =>
    database
      .select({
        id: approvals.id,
        ownerUserId: approvals.ownerUserId,
        requestedByAgentId: approvals.requestedByAgentId,
        requestedByName: sql<
          string | null
        >`(select name from agents where agents.id = ${approvals.requestedByAgentId})`,
        kind: approvals.kind,
        targetAgentId: approvals.targetAgentId,
        targetAgentName: sql<
          string | null
        >`(select name from agents where agents.id = ${approvals.targetAgentId})`,
        targetId: approvals.targetId,
        summary: approvals.summary,
        payload: approvals.payload,
        status: approvals.status,
        result: approvals.result,
        createdAt: approvals.createdAt,
        expiresAt: approvals.expiresAt,
        decidedAt: approvals.decidedAt,
        decidedBy: approvals.decidedBy,
        threadId: approvals.threadId,
        runId: approvals.runId,
        /*
         * The outer column is spelled out with its table. Interpolated as `${approvals.threadId}`
         * drizzle writes a bare "thread_id", which inside this subquery is the mappings table's own
         * column: the condition was always true and every request linked to the first conversation
         * anybody had (found walking a remote employee's held call in the browser).
         */
        channelId: sql<
          string | null
        >`(select m.channel_id from intelligence_channel_mappings m where m.thread_id = "approvals"."thread_id" limit 1)`,
      })
      .from(approvals);

  const asRecord = (row: Awaited<ReturnType<typeof readOne>>[number]) =>
    ({ ...row, status: row.status as ApprovalStatus }) as ApprovalRecord;
  const readOne = (id: string) => select().where(eq(approvals.id, id));

  /** Lapses whatever has waited too long, so a list never shows a request nobody can still act on. */
  const lapse = (ownerUserId: string) =>
    database
      .update(approvals)
      .set({ status: "expired", decidedAt: now() })
      .where(
        and(
          eq(approvals.ownerUserId, ownerUserId),
          eq(approvals.status, "pending"),
          lt(approvals.expiresAt, now()),
        ),
      );

  return {
    async request(input) {
      if (!executors[input.kind]) {
        throw new ApprovalRefusedError(
          `${input.kind} is not a change anybody can be asked to approve.`,
        );
      }
      const summary = input.summary.trim().slice(0, MAX_SUMMARY);
      if (!summary) {
        throw new ApprovalRefusedError("A request has to say what it changes.");
      }
      await lapse(input.ownerUserId);
      const id = input.key
        ? `apr_${createHash("sha256")
            .update(`${input.ownerUserId}\u0000${input.kind}\u0000${input.key}`)
            .digest("hex")
            .slice(0, 32)}`
        : `apr_${crypto.randomUUID()}`;
      if (input.key) {
        // Already asked: the same request, not a second one, and nothing new for the trail.
        const [existing] = await readOne(id);
        if (existing) return asRecord(existing);
      }
      // The count and the insert are one step, so a model asking ten times at once cannot take the
      // cap with it.
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`approvals:${input.requestedByAgentId}`}))`,
        );
        const [{ waiting } = { waiting: 0 }] = await transaction
          .select({ waiting: sql<number>`count(*)::int` })
          .from(approvals)
          .where(
            and(
              eq(approvals.requestedByAgentId, input.requestedByAgentId),
              eq(approvals.status, "pending"),
            ),
          );
        if (waiting >= MAX_PENDING_PER_AGENT) {
          throw new ApprovalRefusedError(
            `You already have ${waiting} requests waiting for a decision. Wait for those before asking for more.`,
          );
        }
        await transaction.insert(approvals).values({
          id,
          ownerUserId: input.ownerUserId,
          requestedByAgentId: input.requestedByAgentId,
          kind: input.kind,
          targetAgentId: input.targetAgentId ?? null,
          targetId: input.targetId ?? null,
          summary,
          payload: input.payload ?? {},
          expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS),
          threadId: input.threadId ?? null,
          runId: input.runId ?? null,
        });
      });
      const [row] = await readOne(id);
      if (!row) throw new ApprovalNotFoundError();
      const record = asRecord(row);
      await audit("approval.requested", record);
      return record;
    },

    async get(ownerUserId, id) {
      await lapse(ownerUserId);
      const [row] = await readOne(id);
      if (!row || row.ownerUserId !== ownerUserId) return null;
      return asRecord(row);
    },

    async find(id) {
      const [row] = await readOne(id);
      return row ? asRecord(row) : null;
    },

    async list(ownerUserId, which = "pending", limit = 50) {
      await lapse(ownerUserId);
      const rows = await select()
        .where(
          and(
            eq(approvals.ownerUserId, ownerUserId),
            which === "pending"
              ? eq(approvals.status, "pending")
              : inArray(approvals.status, [
                  "pending",
                  "approved",
                  "rejected",
                  "expired",
                  "failed",
                ]),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(Math.min(Math.max(limit, 1), 200));
      return rows.map(asRecord);
    },

    async pendingCount(ownerUserId) {
      await lapse(ownerUserId);
      const [row] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(approvals)
        .where(
          and(
            eq(approvals.ownerUserId, ownerUserId),
            eq(approvals.status, "pending"),
          ),
        );
      return row?.count ?? 0;
    },

    async decide(ownerUserId, id, decision) {
      await lapse(ownerUserId);
      // Claimed before anything runs: the condition is the lock, and exactly one caller gets a row back.
      const claimed = await database
        .update(approvals)
        .set({
          status: decision === "approve" ? "approved" : "rejected",
          decidedAt: now(),
          decidedBy: ownerUserId,
        })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.ownerUserId, ownerUserId),
            eq(approvals.status, "pending"),
          ),
        )
        .returning({ id: approvals.id });
      if (claimed.length === 0) {
        // Somebody else's id and a missing one read the same, so ids cannot be probed.
        const [existing] = await readOne(id);
        if (!existing || existing.ownerUserId !== ownerUserId) {
          throw new ApprovalNotFoundError();
        }
        throw new ApprovalNotPendingError(existing.status as ApprovalStatus);
      }
      const [row] = await readOne(id);
      if (!row) throw new ApprovalNotFoundError();
      const record = asRecord(row);

      if (decision === "reject") {
        await audit("approval.rejected", record, ownerUserId);
        await settle(record, null);
        return record;
      }

      /*
       * The decision is written before the executor runs, so the trail says who approved what even
       * when what they approved then fails — and in that order, so a reader sees the yes before the
       * row that records what the yes did.
       */
      await audit("approval.approved", record, ownerUserId);
      const executor = executors[record.kind];
      let text: string | null = null;
      try {
        if (!executor) throw new Error(`Nothing applies a ${record.kind}.`);
        text = await executor(record);
        await database
          .update(approvals)
          .set({ result: text.slice(0, 1000) })
          .where(eq(approvals.id, id));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "It could not be applied.";
        text = null;
        await database
          .update(approvals)
          .set({ status: "failed", result: message.slice(0, 1000) })
          .where(eq(approvals.id, id));
        await audit("approval.failed", record, ownerUserId, {
          reason: message.slice(0, 300),
        });
      }
      const [after] = await readOne(id);
      const final = after ? asRecord(after) : record;
      await settle(final, text);
      return final;
    },
  };
}

/** Whether a row can still be acted on. */
export function isWaiting(record: Pick<ApprovalRecord, "status">): boolean {
  return record.status === "pending";
}
