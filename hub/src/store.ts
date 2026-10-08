import { randomUUID } from "node:crypto";
import { foldMessages, type ThreadMessage } from "./fold";
import type { Sql } from "./db";

export interface ThreadSummary {
  id: string;
  name: string | null;
  lastRunAt?: string;
  lastUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  agentId: string;
  createdById: string;
}

export interface StoredEvent {
  seq: number;
  eventId: string;
  runId: string | null;
  payload: Record<string, unknown> & { type?: string };
  /**
   * The sequence number of the conversation's event just before this one (0 for the first), set on
   * an event as it is stored and passed along the live bus. A socket that is sent events as they
   * happen compares it with the last it sent: if they differ it missed one (the bus can lose an
   * announcement when a connection drops) and reads the log to catch up before going on. Absent on
   * events read back from the log, which are in order by construction.
   */
  prev?: number;
}

export interface LockGrant {
  threadId: string;
  runId: string;
  lock: { key: string; ttlSeconds: number };
}

/** The conversation is held by a different run that has not expired. */
export class LockConflict extends Error {
  constructor() {
    super("thread is locked by another run");
    this.name = "LockConflict";
  }
}

export class NotFound extends Error {
  constructor(what = "thread") {
    super(`${what} not found`);
    this.name = "NotFound";
  }
}

export class Conflict extends Error {
  constructor(what = "thread already exists") {
    super(what);
    this.name = "Conflict";
  }
}

interface ThreadRow {
  id: string;
  user_id: string;
  agent_id: string;
  name: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
}

const iso = (date: Date) => date.toISOString();

function summarize(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    name: row.name,
    ...(row.last_run_at ? { lastRunAt: iso(row.last_run_at) } : {}),
    lastUpdatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archived: row.archived,
    agentId: row.agent_id,
    createdById: row.user_id,
  };
}

const TERMINAL = new Set(["RUN_FINISHED", "RUN_ERROR"]);
export const isTerminalEvent = (event: { type?: string }) =>
  TERMINAL.has(event.type ?? "");

/**
 * `at` is the sort time to the MICROSECOND, as text from the database. A JavaScript Date holds
 * milliseconds, and a cursor rounded to the millisecond skips any thread created in the same
 * millisecond as the last one on the page (the comparison is on the exact value in the database).
 * It goes back to the database as text and is cast there (`::text::timestamptz`): the driver turns
 * anything it is told is a timestamp into a Date first, which rounds it again.
 */
const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify({ at, id })).toString("base64url");

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof value?.at === "string" && typeof value?.id === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

export class HubStore {
  constructor(private readonly sql: Sql) {}

  // ---- threads -------------------------------------------------------------

  async createThread(input: {
    threadId: string;
    userId: string;
    agentId: string;
    name?: string;
  }): Promise<ThreadSummary> {
    const rows = await this.sql<ThreadRow[]>`
      insert into hub_threads (id, user_id, agent_id, name)
      values (${input.threadId}, ${input.userId}, ${input.agentId}, ${input.name ?? null})
      on conflict (id) do nothing
      returning *`;
    if (rows.length === 0) throw new Conflict();
    return summarize(rows[0] as ThreadRow);
  }

  /** Null for a thread that does not exist or belongs to someone else. */
  async getThread(
    threadId: string,
    userId: string,
  ): Promise<ThreadSummary | null> {
    const rows = await this.sql<ThreadRow[]>`
      select * from hub_threads where id = ${threadId} and user_id = ${userId}`;
    return rows[0] ? summarize(rows[0]) : null;
  }

  async listThreads(input: {
    userId: string;
    agentId?: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const after = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.sql<(ThreadRow & { cursor_at: string })[]>`
      select *,
        to_char(
          coalesce(last_run_at, created_at) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) as cursor_at
      from hub_threads
      where user_id = ${input.userId}
        and (${input.agentId ?? null}::text is null or agent_id = ${input.agentId ?? null})
        and (${!!input.includeArchived} or not archived)
        and (
          ${after === null}
          or (coalesce(last_run_at, created_at), id) < (${after?.at ?? null}::text::timestamptz, ${after?.id ?? null}::text)
        )
      order by coalesce(last_run_at, created_at) desc, id desc
      limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      threads: page.map(summarize),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.cursor_at, last.id)
          : null,
    };
  }

  async updateThread(input: {
    threadId: string;
    userId: string;
    name?: string;
    archived?: boolean;
  }): Promise<ThreadSummary | null> {
    const rows = await this.sql<ThreadRow[]>`
      update hub_threads set
        name = case when ${input.name !== undefined} then ${input.name ?? null} else name end,
        archived = case when ${input.archived !== undefined} then ${input.archived ?? false} else archived end,
        updated_at = now()
      where id = ${input.threadId} and user_id = ${input.userId}
      returning *`;
    return rows[0] ? summarize(rows[0]) : null;
  }

  async deleteThread(threadId: string, userId: string): Promise<boolean> {
    const rows = await this.sql`
      delete from hub_threads where id = ${threadId} and user_id = ${userId}
      returning id`;
    return rows.length > 0;
  }

  // ---- run lock ------------------------------------------------------------

  /**
   * One run at a time per conversation. The same run asking again is idempotent; a different run
   * is refused until the holder's lock expires or is released.
   */
  async acquireLock(input: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    ttlSeconds: number;
    lockKeyPrefix?: string;
  }): Promise<LockGrant> {
    const thread = await this.getThread(input.threadId, input.userId);
    if (!thread) throw new NotFound();
    const key = `${input.lockKeyPrefix ?? ""}thread:${input.threadId}`;
    const rows = await this.sql`
      insert into hub_thread_locks (thread_id, run_id, user_id, agent_id, lock_key, expires_at)
      values (${input.threadId}, ${input.runId}, ${input.userId}, ${input.agentId}, ${key},
              now() + make_interval(secs => ${input.ttlSeconds}))
      on conflict (thread_id) do update set
        run_id = excluded.run_id,
        user_id = excluded.user_id,
        agent_id = excluded.agent_id,
        lock_key = excluded.lock_key,
        expires_at = excluded.expires_at
      where hub_thread_locks.expires_at <= now()
         or hub_thread_locks.run_id = excluded.run_id
      returning run_id`;
    if (rows.length === 0) throw new LockConflict();
    return {
      threadId: input.threadId,
      runId: input.runId,
      lock: { key, ttlSeconds: input.ttlSeconds },
    };
  }

  /** False when this run no longer holds the lock. */
  async renewLock(input: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }): Promise<boolean> {
    const rows = await this.sql`
      update hub_thread_locks
      set expires_at = now() + make_interval(secs => ${input.ttlSeconds})
      where thread_id = ${input.threadId} and run_id = ${input.runId}
      returning thread_id`;
    return rows.length > 0;
  }

  async releaseLock(threadId: string, runId: string): Promise<void> {
    await this.sql`
      delete from hub_thread_locks where thread_id = ${threadId} and run_id = ${runId}`;
  }

  /** The unexpired lock on a conversation, if a run is in progress. */
  async activeLock(threadId: string): Promise<{
    runId: string;
    userId: string;
    agentId: string;
    key: string;
  } | null> {
    const rows = await this.sql<
      { run_id: string; user_id: string; agent_id: string; lock_key: string }[]
    >`
      select run_id, user_id, agent_id, lock_key from hub_thread_locks
      where thread_id = ${threadId} and expires_at > now()`;
    const row = rows[0];
    return row
      ? {
          runId: row.run_id,
          userId: row.user_id,
          agentId: row.agent_id,
          key: row.lock_key,
        }
      : null;
  }

  /** Whether `runId` holds the conversation's unexpired lock. */
  async holdsLock(threadId: string, runId: string): Promise<boolean> {
    return (await this.activeLock(threadId))?.runId === runId;
  }

  // ---- events --------------------------------------------------------------

  /**
   * Appends events in order. An event already stored (same id on the same thread) is skipped, so a
   * runner that resends after a dropped acknowledgement does not duplicate anything.
   *
   * Returns only the events that were new.
   */
  async appendEvents(
    threadId: string,
    runId: string | null,
    events: Array<Record<string, unknown> & { type?: string }>,
  ): Promise<StoredEvent[]> {
    const stored: StoredEvent[] = [];
    await this.sql.begin(async (tx) => {
      // Appended by one run at a time (the conversation's lock), so nothing else is adding between
      // this read and the inserts below.
      const [tail] = await tx<{ seq: string | null }[]>`
        select max(seq) as seq from hub_events where thread_id = ${threadId}`;
      let previous = Number(tail?.seq ?? 0);
      for (const payload of events) {
        const metadata = payload.metadata as
          | { cpki_event_id?: unknown }
          | undefined;
        const eventId =
          typeof metadata?.cpki_event_id === "string" && metadata.cpki_event_id
            ? metadata.cpki_event_id
            : randomUUID();
        const rows = await tx<{ seq: string }[]>`
          insert into hub_events (thread_id, run_id, event_id, type, payload)
          values (${threadId}, ${runId}, ${eventId}, ${payload.type ?? "UNKNOWN"}, ${tx.json(payload as never)})
          on conflict (thread_id, event_id) do nothing
          returning seq`;
        if (rows[0]) {
          const seq = Number(rows[0].seq);
          stored.push({ seq, eventId, runId, payload, prev: previous });
          previous = seq;
        }
      }
      if (stored.length > 0) {
        await tx`
          update hub_threads set updated_at = now(),
            last_run_at = case when ${stored.some((e) => e.payload.type === "RUN_STARTED")}
                               then now() else last_run_at end
          where id = ${threadId}`;
      }
    });
    return stored;
  }

  /**
   * Events to replay to someone joining a conversation.
   *
   * - `runId`: that run's events from its start.
   * - `afterEventId`: only what came after that event, if it is known; an unknown cursor falls back
   *   to everything, because replaying too much is safe and replaying too little is not.
   * - neither: the whole conversation.
   */
  /** The sequence number of the conversation's newest event, or 0 if it has none. */
  async latestSeq(threadId: string): Promise<number> {
    const [row] = await this.sql<{ seq: string | null }[]>`
      select max(seq) as seq from hub_events where thread_id = ${threadId}`;
    return Number(row?.seq ?? 0);
  }

  async eventsForReplay(
    threadId: string,
    options: {
      runId?: string;
      afterEventId?: string | null;
      /** Only events after this sequence number. Takes the place of `afterEventId` when both are given. */
      afterSeq?: number;
    } = {},
  ): Promise<StoredEvent[]> {
    let afterSeq = options.afterSeq ?? 0;
    if (options.afterSeq === undefined && options.afterEventId) {
      const cursor = await this.sql<{ seq: string }[]>`
        select seq from hub_events
        where thread_id = ${threadId} and event_id = ${options.afterEventId}`;
      if (cursor[0]) afterSeq = Number(cursor[0].seq);
    }
    const rows = await this.sql<
      {
        seq: string;
        event_id: string;
        run_id: string | null;
        payload: StoredEvent["payload"];
      }[]
    >`
      select seq, event_id, run_id, payload from hub_events
      where thread_id = ${threadId}
        and seq > ${afterSeq}
        and (${options.runId ?? null}::text is null or run_id = ${options.runId ?? null})
      order by seq`;
    return rows.map((row) => ({
      seq: Number(row.seq),
      eventId: row.event_id,
      runId: row.run_id,
      payload: row.payload,
    }));
  }

  async latestEventId(threadId: string): Promise<string | null> {
    const rows = await this.sql<{ event_id: string }[]>`
      select event_id from hub_events where thread_id = ${threadId}
      order by seq desc limit 1`;
    return rows[0]?.event_id ?? null;
  }

  async threadMessages(threadId: string): Promise<ThreadMessage[]> {
    const events = await this.eventsForReplay(threadId);
    return foldMessages(events.map((event) => event.payload));
  }
}
