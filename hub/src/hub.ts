import type { EventBus } from "./bus";
import type { HubConfig } from "./config";
import type { HubStore, StoredEvent, ThreadSummary } from "./store";
import { joinCodeFor, signJoinToken } from "./tokens";

export type ThreadOperation = "created" | "updated" | "archived" | "deleted";

/**
 * Everything the REST API and the realtime gateway share: the store, the bus, and the rules for
 * what gets announced to whom.
 */
export class Hub {
  /** Set once the process has been told to stop, so `/ready` says so before the platform notices. */
  draining = false;

  constructor(
    readonly config: HubConfig,
    readonly store: HubStore,
    readonly bus: EventBus,
  ) {}

  threadToken(threadId: string, userId: string): string {
    return signJoinToken(
      this.config.joinSecret,
      { kind: "thread", threadId, userId },
      this.config.joinTokenTtlSeconds,
    );
  }

  metaToken(userId: string): string {
    return signJoinToken(
      this.config.joinSecret,
      { kind: "meta", userId },
      this.config.joinTokenTtlSeconds,
    );
  }

  metaTopic(userId: string): string {
    return `user_meta:${joinCodeFor(this.config.joinSecret, userId)}`;
  }

  /** Tells a person's open thread lists that one of their threads changed. */
  announceThread(
    operation: ThreadOperation,
    thread: Pick<ThreadSummary, "id" | "createdById"> & Partial<ThreadSummary>,
  ): void {
    this.bus.publish(this.metaTopic(thread.createdById), "thread_metadata", {
      operation,
      threadId: thread.id,
      thread,
      ...(operation === "deleted" ? { deleted: { id: thread.id } } : {}),
    });
  }

  /** Announces a run starting or ending, so a thread list can show which are busy. */
  announceRunActivity(
    thread: Pick<ThreadSummary, "id" | "createdById" | "agentId">,
    runId: string | null,
    event: StoredEvent,
  ): void {
    this.bus.publish(
      this.metaTopic(thread.createdById),
      "thread_run_activity",
      {
        threadId: thread.id,
        agentId: thread.agentId,
        runId,
        eventType: event.payload.type,
        latestEventId: event.eventId,
      },
    );
  }
}
