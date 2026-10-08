/**
 * Fan-out of events to whoever is listening on a topic, within one hub process.
 *
 * Deliberately tiny and synchronous. Anything that must survive a restart is in the database;
 * this only moves a live event from the place that stored it to the sockets watching.
 *
 * To run more than one hub process, replace this with a Postgres LISTEN/NOTIFY bus that has the
 * same two methods. Nothing else needs to change.
 */
export type Listener = (event: string, payload: unknown) => void;

export class Bus {
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
}
