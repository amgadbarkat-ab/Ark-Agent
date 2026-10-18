import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { approvals } from "../db/schema";

/**
 * Changes one digital employee wants made to another's work, held until a person decides.
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
};

/** Applies one approved change and says, in a sentence, what it did. A throw is a failure, with its message. */
export type ApprovalExecutor = (approval: ApprovalRecord) => Promise<string>;

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
};

export type ApprovalStore = {
  request(input: ApprovalInput): Promise<ApprovalRecord>;
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
    auditStore?: AuditStore;
    now?: () => Date;
  },
): ApprovalStore {
  const { executors, auditStore } = options;
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
      const [{ waiting } = { waiting: 0 }] = await database
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
      const id = `apr_${crypto.randomUUID()}`;
      await database.insert(approvals).values({
        id,
        ownerUserId: input.ownerUserId,
        requestedByAgentId: input.requestedByAgentId,
        kind: input.kind,
        targetAgentId: input.targetAgentId ?? null,
        targetId: input.targetId ?? null,
        summary,
        payload: input.payload ?? {},
        expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS),
      });
      const [row] = await readOne(id);
      if (!row) throw new ApprovalNotFoundError();
      const record = asRecord(row);
      await audit("approval.requested", record);
      return record;
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
        return record;
      }

      const executor = executors[record.kind];
      try {
        if (!executor) throw new Error(`Nothing applies a ${record.kind}.`);
        const result = await executor(record);
        await database
          .update(approvals)
          .set({ result: result.slice(0, 1000) })
          .where(eq(approvals.id, id));
        await audit("approval.approved", record, ownerUserId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "It could not be applied.";
        await database
          .update(approvals)
          .set({ status: "failed", result: message.slice(0, 1000) })
          .where(eq(approvals.id, id));
        await audit("approval.failed", record, ownerUserId, {
          reason: message.slice(0, 300),
        });
      }
      const [after] = await readOne(id);
      return after ? asRecord(after) : record;
    },
  };
}

/** Whether a row can still be acted on. */
export function isWaiting(record: Pick<ApprovalRecord, "status">): boolean {
  return record.status === "pending";
}
