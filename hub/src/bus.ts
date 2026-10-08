/**
 * Fan-out of events to whoever is listening on a topic.
 *
 * Deliberately tiny. Anything that must survive a restart is in the database; this only moves a
 * live event from the place that stored it to the sockets watching. {@link Bus} does that within one
 * hub process. `SharedBus` (shared-bus.ts) does it across several, through PostgreSQL, and is what a
 * hosted deployment runs.
 */
export type Listener = (event: string, payload: unknown) => void;

export interface EventBus {
  subscribe(topic: string, listener: Listener): () => void;
  /** Tells everyone listening on the topic, in this process and in any other that shares the bus. */
  publish(topic: string, event: string, payload: unknown): void;
  /** Listeners in THIS process. */
  listenerCount(topic: string): number;
  /**
   * Called when events may have been missed (a shared bus lost its connection and got it back). A
   * listener that keeps state it can rebuild from the database does so here. A bus within one
   * process never has a gap.
   */
  onResync(callback: () => void): () => void;
  close(): Promise<void>;
}

export class Bus implements EventBus {
  private readonly topics = new Map<string, Set<Listener>>();

  subscribe(topic: string, listener: Listener): () => void {
    let listeners = this.topics.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.topics.set(topic, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.topics.get(topic) === listeners) {
        this.topics.delete(topic);
      }
    };
  }

  publish(topic: string, event: string, payload: unknown): void {
    for (const listener of [...(this.topics.get(topic) ?? [])]) {
      try {
        listener(event, payload);
      } catch {
        // One broken socket must not stop the others from hearing the event.
      }
    }
  }

  listenerCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  onResync(): () => void {
    return () => {};
  }

  async close(): Promise<void> {}
}
