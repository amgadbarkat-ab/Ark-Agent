/**
 * Leaving without cutting anybody off.
 *
 * When a pod is replaced (every deploy, every node upgrade) it is told to stop, and the cheapest thing
 * for a process to do is exit. Every request being answered, every reply being streamed to somebody,
 * ends on the spot. For a product whose main thing is a coworker working on a task for minutes at a
 * time, "every deploy interrupts everybody's work" is not acceptable, so this is the other way:
 *
 *   1. Keep serving for a moment (`settleMs`). The platform takes a pod out of rotation at the same
 *      time as it tells it to stop, and the news takes a few seconds to reach everything that routes to
 *      it; stopping to listen at once would refuse the requests still arriving in that gap.
 *   2. Stop listening. New connections go to the other pods.
 *   3. Wait until nothing is being answered, or until `graceMs` is up, whichever is first.
 *   4. Close what is left (sockets, which the people on them re-open on another pod), release what the
 *      process holds, and leave.
 *
 * A second signal while this is going on means somebody is watching and impatient: it skips the waiting.
 * `graceMs` plus `settleMs` has to be less than the platform's own limit
 * (`terminationGracePeriodSeconds`), or the platform kills the process mid-wait, which is the thing
 * being avoided.
 */
export type DrainOptions = {
  /** How many requests are still being answered, including replies still streaming. */
  pending: () => number;
  /** Refuse new connections. Must not wait for the ones in progress. */
  stopListening: () => void;
  /** Close everything still open. */
  closeAll: () => void | Promise<void>;
  /** Release what the process holds (database listeners and the like). Failures are ignored. */
  cleanup: () => Promise<unknown>;
  exit: (code: number) => void;
  log: (line: string) => void;
  settleMs: number;
  graceMs: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export function createDrain(options: DrainOptions) {
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => Date.now());
  const poll = options.pollMs ?? 100;
  let started: Promise<void> | undefined;
  let hurry = false;

  async function run(signal: string) {
    const log = (phase: string, extra: Record<string, unknown> = {}) =>
      options.log(
        JSON.stringify({ type: "shutdown", signal, phase, ...extra }),
      );
    log("draining", { pending: options.pending() });

    // 1. Still serving, while the news that this pod is leaving spreads.
    const settleUntil = now() + options.settleMs;
    while (!hurry && now() < settleUntil) {
      await sleep(Math.min(poll, Math.max(1, settleUntil - now())));
    }

    // 2. No new connections.
    try {
      options.stopListening();
    } catch (error) {
      log("stop-listening-failed", { error: String(error).slice(0, 120) });
    }

    // 3. Let what is under way finish, for as long as it is allowed to.
    const deadline = now() + options.graceMs;
    let forced = false;
    while (options.pending() > 0) {
      if (hurry || now() >= deadline) {
        forced = true;
        break;
      }
      await sleep(poll);
    }
    log(forced ? "forced" : "idle", { pending: options.pending() });

    // 4. Close the rest, put things down, leave.
    try {
      await options.closeAll();
    } catch {
      // Leaving anyway.
    }
    await options.cleanup().catch(() => undefined);
    log("exit");
    options.exit(0);
  }

  return {
    /** Begin leaving. Safe to call again: a second call only makes the first one stop waiting. */
    begin(signal: string): Promise<void> {
      if (started) {
        hurry = true;
        return started;
      }
      started = run(signal);
      return started;
    },
    draining: () => started !== undefined,
  };
}
