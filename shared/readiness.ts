/**
 * Whether this process should be sent requests right now.
 *
 * Not the same question as whether it is alive. A process whose database has stopped answering, or
 * whose connection pool is wedged, is still running and `/health` still says so, and restarting it for
 * that is rarely the right answer. Taking it out of rotation until it can answer is: its share of the
 * traffic goes to the pods that can, and the platform shows it as not ready, which is something a
 * person looking at the cluster can see. A process that has been told to stop says so as soon as it is
 * told, which is quicker than the platform noticing.
 *
 * The answer carries one word and no detail: it is reachable by whatever probes the pod.
 */
export type Readiness = {
  ok: boolean;
  status: "ok" | "draining" | "unavailable";
};

export function createReadiness(options: {
  /** One cheap round trip to the database. Throwing, or not returning in time, is "not ready". */
  ping: () => Promise<unknown>;
  draining: () => boolean;
  timeoutMs?: number;
}): () => Promise<Readiness> {
  const timeoutMs = options.timeoutMs ?? 2000;
  return async () => {
    if (options.draining()) return { ok: false, status: "draining" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
        }),
      ]);
      return { ok: true, status: "ok" };
    } catch {
      return { ok: false, status: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };
}
