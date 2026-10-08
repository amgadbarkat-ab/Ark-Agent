import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { CloudUsage } from "../../../shared/cloud-pricing";
import type { Database } from "../db/client";
import { cloudIntervals } from "../db/schema";
import { clip, merge, periodBounds, seconds, type Span } from "./intervals";

/**
 * A record of when the cloud was in use for each coworker, and how much of it, for each account.
 *
 * Everything here is an interval with a start, a last time somebody saw it alive, and an end that
 * may be missing. A run is an interval, and so is a coworker's computer being up, and so is the
 * storage it holds. The cost of running something somewhere is time, and an interval is the honest
 * shape of time: it can be clipped to a month, merged with another so that one hour is not counted
 * twice, and bounded by the last moment anything saw it, so that a crashed process becomes a short
 * charge and not an endless one.
 *
 * Recording is idempotent and safe from several server processes at once: opening an interval that
 * is already open is a refresh, because the database refuses a second open interval for the same
 * computer.
 */

export type CloudMeter = {
  runStarted: (input: {
    tenantId: string;
    botId: string;
    runId: string;
    at?: Date;
  }) => Promise<void>;
  /** Still working. */
  runSeen: (runId: string, at?: Date) => Promise<void>;
  runEnded: (runId: string, at?: Date) => Promise<void>;
  computerSeen: (input: {
    tenantId: string;
    botId: string;
    at?: Date;
  }) => Promise<void>;
  computerStopped: (botId: string, at?: Date) => Promise<void>;
  /** The coworker's storage exists, and is this big. */
  storageSeen: (input: {
    tenantId: string;
    botId: string;
    bytes: number;
    at?: Date;
  }) => Promise<void>;
  storageCleared: (botId: string, at?: Date) => Promise<void>;
  /**
   * Close whatever nobody has seen for a while, at the last moment anybody did. Returns how many.
   * Never changes what a period is worth (an unclosed interval is already bounded by when it was
   * last seen); it keeps the open set small and the picture honest.
   */
  closeStale: (staleAfterMs: number, now?: Date) => Promise<number>;
  /** The coworkers whose computer (or storage) is recorded as present right now. */
  openBots: (source: "computer" | "storage") => Promise<string[]>;
  /** What an account used in a calendar month (UTC), merged and clipped. */
  usageFor: (
    tenantId: string,
    period: string,
    options?: { since?: Date },
  ) => Promise<CloudUsage>;
  /** Which accounts used anything in a month. */
  tenantsWithUsage: (period: string) => Promise<string[]>;
};

const asSpan = (row: {
  startedAt: Date;
  lastSeenAt: Date;
  endedAt: Date | null;
}): Span => ({
  start: row.startedAt.getTime(),
  // An interval that was ended is worth until it ended, but never beyond the last time it was seen
  // by more than the end says; one that was not is worth only what was seen of it.
  end: (row.endedAt ?? row.lastSeenAt).getTime(),
});

export function createCloudMeter(database: Database): CloudMeter {
  async function open(input: {
    tenantId: string;
    botId: string;
    source: "computer" | "storage";
    at: Date;
    bytes?: number;
  }) {
    // The partial unique index (source, bot) where open is what makes a second replica's insert a
    // refresh of the same interval instead of a second interval.
    await database
      .insert(cloudIntervals)
      .values({
        tenantId: input.tenantId,
        botId: input.botId,
        source: input.source,
        ref: `${input.botId}:${input.at.getTime()}`,
        startedAt: input.at,
        lastSeenAt: input.at,
        bytes: input.bytes ?? null,
      })
      .onConflictDoUpdate({
        target: [cloudIntervals.source, cloudIntervals.botId],
        targetWhere: sql`${cloudIntervals.endedAt} is null and ${cloudIntervals.source} <> 'run'`,
        set: {
          lastSeenAt: input.at,
          ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
        },
      });
  }

  const close = async (
    source: "computer" | "storage",
    botId: string,
    at: Date,
  ) => {
    await database
      .update(cloudIntervals)
      .set({
        endedAt: sql`greatest(${cloudIntervals.lastSeenAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(cloudIntervals.source, source),
          eq(cloudIntervals.botId, botId),
          isNull(cloudIntervals.endedAt),
        ),
      );
  };

  return {
    async runStarted({ tenantId, botId, runId, at = new Date() }) {
      await database
        .insert(cloudIntervals)
        .values({
          tenantId,
          botId,
          source: "run",
          ref: runId,
          startedAt: at,
          lastSeenAt: at,
        })
        // A run that is begun again with the same id (a retry) continues the interval.
        .onConflictDoNothing();
    },
    async runSeen(runId, at = new Date()) {
      await database
        .update(cloudIntervals)
        .set({ lastSeenAt: at })
        .where(
          and(
            eq(cloudIntervals.source, "run"),
            eq(cloudIntervals.ref, runId),
            isNull(cloudIntervals.endedAt),
          ),
        );
    },
    async runEnded(runId, at = new Date()) {
      await database
        .update(cloudIntervals)
        .set({
          endedAt: sql`greatest(${cloudIntervals.lastSeenAt}, ${at.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(cloudIntervals.source, "run"),
            eq(cloudIntervals.ref, runId),
            isNull(cloudIntervals.endedAt),
          ),
        );
    },
    computerSeen: ({ tenantId, botId, at = new Date() }) =>
      open({ tenantId, botId, source: "computer", at }),
    computerStopped: (botId, at = new Date()) => close("computer", botId, at),
    storageSeen: ({ tenantId, botId, bytes, at = new Date() }) =>
      open({ tenantId, botId, source: "storage", at, bytes }),
    storageCleared: (botId, at = new Date()) => close("storage", botId, at),

    async closeStale(staleAfterMs, now = new Date()) {
      const cutoff = new Date(now.getTime() - staleAfterMs);
      const closed = await database
        .update(cloudIntervals)
        .set({ endedAt: cloudIntervals.lastSeenAt })
        .where(
          and(
            isNull(cloudIntervals.endedAt),
            lt(cloudIntervals.lastSeenAt, cutoff),
          ),
        )
        .returning({ id: cloudIntervals.id });
      return closed.length;
    },

    async usageFor(tenantId, period, options) {
      const bounds = periodBounds(period);
      const { end } = bounds;
      // Only what happened after `since`: what a person is charged for starts when they agreed to it.
      const start = options?.since
        ? new Date(Math.max(bounds.start.getTime(), options.since.getTime()))
        : bounds.start;
      const window: Span = { start: start.getTime(), end: end.getTime() };
      const rows = await database
        .select({
          botId: cloudIntervals.botId,
          source: cloudIntervals.source,
          startedAt: cloudIntervals.startedAt,
          lastSeenAt: cloudIntervals.lastSeenAt,
          endedAt: cloudIntervals.endedAt,
          bytes: cloudIntervals.bytes,
        })
        .from(cloudIntervals)
        .where(
          and(
            eq(cloudIntervals.tenantId, tenantId),
            lt(cloudIntervals.startedAt, end),
            or(
              gt(cloudIntervals.lastSeenAt, start),
              gt(cloudIntervals.endedAt, start),
            ),
          ),
        );

      // Compute: per coworker, the runs and the computer merged, so an hour is one hour.
      const byBot = new Map<string, Span[]>();
      let storageByteSeconds = 0;
      for (const row of rows) {
        const clipped = clip(asSpan(row), window);
        if (!clipped) continue;
        if (row.source === "storage") {
          storageByteSeconds += Number(row.bytes ?? 0) * seconds([clipped]);
        } else {
          const list = byBot.get(row.botId) ?? [];
          list.push(clipped);
          byBot.set(row.botId, list);
        }
      }
      let computeSeconds = 0;
      for (const spans of byBot.values()) {
        computeSeconds += seconds(merge(spans));
      }
      return { computeSeconds, storageByteSeconds, egressBytes: 0 };
    },

    async openBots(source) {
      const rows = await database
        .select({ botId: cloudIntervals.botId })
        .from(cloudIntervals)
        .where(
          and(
            eq(cloudIntervals.source, source),
            isNull(cloudIntervals.endedAt),
          ),
        );
      return rows.map((row) => row.botId);
    },

    async tenantsWithUsage(period) {
      const { start, end } = periodBounds(period);
      const rows = await database
        .selectDistinct({ tenantId: cloudIntervals.tenantId })
        .from(cloudIntervals)
        .where(
          and(
            lt(cloudIntervals.startedAt, end),
            or(
              gt(cloudIntervals.lastSeenAt, start),
              gt(cloudIntervals.endedAt, start),
            ),
          ),
        );
      return rows.map((row) => row.tenantId);
    },
  };
}
