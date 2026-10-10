import { randomUUID } from "node:crypto";
import { Bus, type EventBus, type Listener } from "./bus";
import type { Sql } from "./db";

/**
 * The bus for several hub processes at once, carried by PostgreSQL's LISTEN/NOTIFY.
 *
 * Live events (a stored event for a conversation, a stop request, a change to a thread list) have to
 * reach the socket that wants them even when it is held by a different process from the one that
 * produced them. A runner may be connected to one replica while the person watching is connected to
 * another, and a rolling update has two replicas alive at once.
 *
 * HOW. `publish` does exactly what the in-process bus does (local listeners hear it at once, in the
 * same call) and also sends a NOTIFY on a channel every process LISTENs on. A process hearing a NOTIFY
 * that it sent itself ignores it, so nothing is delivered twice. A process hearing someone else's
 * delivers it to its own listeners.
 *
 * SIZE. A NOTIFY carries 8000 bytes at most, and events can be larger (a tool's whole result). A big
 * body is written to `hub_bus_overflow` and the NOTIFY carries only its id; whoever hears it reads
 * the row. Rows are removed a few minutes later.
 *
 * ORDER. Sends from one process are serialised, so they reach the others in the order they were
 * made, and each process handles what it receives one at a time, so a large event followed by a small
 * one is delivered large first.
 *
 * LOSS. NOTIFY is not delivered to a connection that is not listening. If this process's connection is
 * lost and comes back, whatever was said in between is gone, and so is nothing that matters: every
 * event is also in the event log. The gateway answers a gap in two ways. Each stored event names its
 * predecessor (`prev`), so a socket that is told of an event whose predecessor it never sent reads the
 * log to catch up, in order, before going on; and when this bus reconnects it tells every open
 * conversation to do the same (`onResync`), which covers the end of a run whose last announcement was
 * lost and nothing followed. What cannot be replayed is a stop request or a thread-list update sent in
 * the gap, which is at worst a stop that has to be pressed again and a list that refreshes on the
 * next change.
 *
 * The channel is named for the schema, so two hubs sharing a database in different schemas (the
 * tests) never hear each other.
 */

/** NOTIFY allows 8000 bytes; this leaves room for its own framing. */
const INLINE_LIMIT = 6_500;
const OVERFLOW_KEEP_MINUTES = 10;
const SWEEP_EVERY_MS = 60_000;

type Wire =
  | { o: string; t: string; e: string; p: unknown }
  | { o: string; r: string };

export class SharedBus implements EventBus {
  private readonly local = new Bus();
  private readonly origin = randomUUID();
  private readonly resyncs = new Set<() => void>();
  private channel = "hub_bus";
  private unlisten: (() => Promise<void>) | undefined;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private outbox: Promise<void> = Promise.resolve();
  private inbox: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly sql: Sql,
    private readonly log: (message: string, error?: unknown) => void = (
      message,
      error,
    ) => console.error(message, error),
  ) {}

  /** Begin listening. Resolves once this process is certain to hear what others publish. */
  async start(): Promise<void> {
    const [row] = await this.sql<{ schema: string }[]>`
      select current_schema() as schema`;
    this.channel =
      `hub_bus_${(row?.schema ?? "public").replace(/[^A-Za-z0-9_]/g, "_")}`.slice(
        0,
        63,
      );
    let first = true;
    const handle = await this.sql.listen(
      this.channel,
      (text) => {
        this.inbox = this.inbox
          .then(() => this.receive(text))
          .catch((error) =>
            this.log("hub bus could not deliver a message", error),
          );
      },
      () => {
        // Called when listening begins and again every time it is re-established after a lost
        // connection. The second and later times mean there is a gap.
        if (first) {
          first = false;
          return;
        }
        this.log("hub bus reconnected; replaying to open conversations");
        for (const callback of [...this.resyncs]) {
          try {
            callback();
          } catch (error) {
            this.log("hub bus resync failed", error);
          }
        }
      },
    );
    this.unlisten = () => handle.unlisten();
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.sweeper.unref?.();
  }

  subscribe(topic: string, listener: Listener): () => void {
    return this.local.subscribe(topic, listener);
  }

  listenerCount(topic: string): number {
    return this.local.listenerCount(topic);
  }

  onResync(callback: () => void): () => void {
    this.resyncs.add(callback);
    return () => {
      this.resyncs.delete(callback);
    };
  }

  publish(topic: string, event: string, payload: unknown): void {
    this.local.publish(topic, event, payload);
    if (this.closed) return;
    this.outbox = this.outbox
      .then(() => this.forward(topic, event, payload))
      .catch((error) =>
        this.log("hub bus could not tell the other processes", error),
      );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    await this.outbox.catch(() => undefined);
    await this.unlisten?.().catch(() => undefined);
    await this.inbox.catch(() => undefined);
  }

  private async forward(
    topic: string,
    event: string,
    payload: unknown,
  ): Promise<void> {
    const body = JSON.stringify({
      o: this.origin,
      t: topic,
      e: event,
      p: payload,
    } satisfies Wire);
    if (Buffer.byteLength(body) <= INLINE_LIMIT) {
      await this.sql.notify(this.channel, body);
      return;
    }
    const [row] = await this.sql<{ id: string }[]>`
      insert into hub_bus_overflow (body) values (${body}) returning id`;
    await this.sql.notify(
      this.channel,
      JSON.stringify({ o: this.origin, r: String(row?.id) } satisfies Wire),
    );
  }

  private async receive(text: string): Promise<void> {
    let wire = JSON.parse(text) as Wire;
    // Our own, already delivered at the moment it was published.
    if (wire.o === this.origin) return;
    if ("r" in wire) {
      const rows = await this.sql<{ body: string }[]>`
        select body from hub_bus_overflow where id = ${wire.r}`;
      const body = rows[0]?.body;
      // Swept before it was read, which means this process was away for ten minutes: the replay on
      // reconnect covers what matters.
      if (!body) return;
      wire = JSON.parse(body) as Wire;
    }
    if ("t" in wire) this.local.publish(wire.t, wire.e, wire.p);
  }

  private async sweep(): Promise<void> {
    try {
      await this.sql`
        delete from hub_bus_overflow
        where created_at < now() - ${OVERFLOW_KEEP_MINUTES} * interval '1 minute'`;
    } catch (error) {
      this.log("hub bus could not tidy its overflow", error);
    }
  }
}
