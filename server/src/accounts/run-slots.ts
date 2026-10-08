import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { runSlots } from "../db/schema";

export type SlotRequest = {
  tenantId: string;
  userId: string;
  botId: string;
  runId: string;
  /** How many different bots may work at once. Null means no limit. */
  limit: number | null;
};

export type SlotResult =
  | { ok: true }
  | { ok: false; active: number; limit: number };

export type RunSlots = {
  /**
   * Take a place for this run, or say how full the account is.
   *
   * Repeating it for the same run keeps the place alive, which is how a run that is working renews
   * its lease. A renewal passes a limit of null: a bot that is already working is never put out
   * because the plan changed under it.
   */
  tryAcquire: (request: SlotRequest) => Promise<SlotResult>;
  release: (tenantId: string, runId: string) => Promise<void>;
  /** How many different bots are working for this account right now. */
  activeBots: (tenantId: string) => Promise<number>;
  readonly ttlMs: number;
};

export const SLOT_TTL_MS = 120_000;

/**
 * Places for bots to work, counted in the database.
 *
 * What is counted is DIFFERENT BOTS working at once, not runs: a second conversation with a bot that
 * is already working takes nothing extra. Each place is a lease that expires, so a process that dies
 * mid-run cannot hold one forever; the counting query simply stops seeing it.
 *
 * In the database rather than in memory so the count is right across several server processes and
 * survives a restart.
 */
export function createRunSlots(
  database: Database,
  options: { ttlMs?: number } = {},
): RunSlots {
  const ttlMs = options.ttlMs ?? SLOT_TTL_MS;
  const expiry = () => new Date(Date.now() + ttlMs);

  async function activeBots(tenantId: string) {
    const [row] = await database
      .select({
        count: sql<number>`count(distinct ${runSlots.botId})::int`,
      })
      .from(runSlots)
      .where(
        and(
          eq(runSlots.tenantId, tenantId),
          gt(runSlots.expiresAt, sql`now()`),
        ),
      );
    return row?.count ?? 0;
  }

  return {
    ttlMs,
    activeBots,

    async tryAcquire(request) {
      return database.transaction(async (tx) => {
        // One account's places are decided one request at a time, so two runs starting together
        // cannot both see room for the last one.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`run-slots:${request.tenantId}`}))`,
        );
        await tx
          .delete(runSlots)
          .where(
            and(
              eq(runSlots.tenantId, request.tenantId),
              lte(runSlots.expiresAt, sql`now()`),
            ),
          );

        const [mine] = await tx
          .select({ id: runSlots.id })
          .from(runSlots)
          .where(
            and(
              eq(runSlots.tenantId, request.tenantId),
              eq(runSlots.runId, request.runId),
            ),
          )
          .limit(1);
        if (mine) {
          await tx
            .update(runSlots)
            .set({ expiresAt: expiry() })
            .where(eq(runSlots.id, mine.id));
          return { ok: true } as const;
        }

        if (request.limit !== null) {
          const [{ distinctBots, thisBot } = { distinctBots: 0, thisBot: 0 }] =
            await tx
              .select({
                distinctBots: sql<number>`count(distinct ${runSlots.botId})::int`,
                thisBot: sql<number>`count(*) filter (where ${runSlots.botId} = ${request.botId})::int`,
              })
              .from(runSlots)
              .where(eq(runSlots.tenantId, request.tenantId));
          // A bot that is already working takes no further place.
          if (thisBot === 0 && distinctBots >= request.limit) {
            return {
              ok: false,
              active: distinctBots,
              limit: request.limit,
            } as const;
          }
        }

        await tx.insert(runSlots).values({
          tenantId: request.tenantId,
          userId: request.userId,
          botId: request.botId,
          runId: request.runId,
          expiresAt: expiry(),
        });
        return { ok: true } as const;
      });
    },

    async release(tenantId, runId) {
      await database
        .delete(runSlots)
        .where(and(eq(runSlots.tenantId, tenantId), eq(runSlots.runId, runId)));
    },
  };
}
