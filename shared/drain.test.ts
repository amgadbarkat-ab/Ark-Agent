import { describe, expect, test } from "bun:test";
import { createDrain } from "./drain";

/** A clock the test moves, so the waits are asserted rather than slept through. */
function world() {
  let time = 0;
  const events: string[] = [];
  let pending = 0;
  const lines: Record<string, unknown>[] = [];
  const options = {
    pending: () => pending,
    stopListening: () => {
      events.push(`stop-listening@${time}`);
    },
    closeAll: () => {
      events.push(`close-all@${time}`);
    },
    cleanup: async () => {
      events.push(`cleanup@${time}`);
    },
    exit: (code: number) => {
      events.push(`exit(${code})@${time}`);
    },
    log: (line: string) => {
      lines.push(JSON.parse(line));
    },
    sleep: async (milliseconds: number) => {
      time += milliseconds;
    },
    now: () => time,
    pollMs: 100,
  };
  return {
    options,
    events,
    lines,
    setPending: (n: number) => {
      pending = n;
    },
    at: () => time,
    finishAt: (when: number, drain: () => void) => {
      const inner = options.sleep;
      options.sleep = async (milliseconds: number) => {
        await inner(milliseconds);
        if (time >= when) drain();
      };
    },
  };
}

describe("leaving", () => {
  test("keeps serving through the settle time, then stops listening, then exits when idle", async () => {
    const w = world();
    const drain = createDrain({ ...w.options, settleMs: 1000, graceMs: 5000 });

    await drain.begin("SIGTERM");

    expect(w.events).toEqual([
      "stop-listening@1000",
      "close-all@1000",
      "cleanup@1000",
      "exit(0)@1000",
    ]);
    expect(w.lines.map((line) => line.phase)).toEqual([
      "draining",
      "idle",
      "exit",
    ]);
  });

  test("waits for what is under way to finish, and no longer than it is allowed", async () => {
    const w = world();
    w.setPending(3);
    w.finishAt(2500, () => w.setPending(0));
    const drain = createDrain({ ...w.options, settleMs: 1000, graceMs: 5000 });

    await drain.begin("SIGTERM");

    // Listening stopped at the end of the settle time; the exit came as the last request ended.
    expect(w.events[0]).toBe("stop-listening@1000");
    expect(w.events.at(-1)).toBe("exit(0)@2500");
    expect(w.lines.find((line) => line.phase === "idle")).toBeDefined();
  });

  test("a request that never ends is cut off when the grace is up, and says so", async () => {
    const w = world();
    w.setPending(2);
    const drain = createDrain({ ...w.options, settleMs: 500, graceMs: 3000 });

    await drain.begin("SIGTERM");

    expect(w.events).toContain("close-all@3500");
    expect(w.events.at(-1)).toBe("exit(0)@3500");
    const forced = w.lines.find((line) => line.phase === "forced");
    expect(forced).toMatchObject({ pending: 2 });
  });

  test("a second signal stops the waiting", async () => {
    const w = world();
    w.setPending(1);
    const drain = createDrain({
      ...w.options,
      settleMs: 10_000,
      graceMs: 60_000,
    });
    const first = drain.begin("SIGTERM");
    // Impatient: the second arrives while the first is still waiting.
    expect(drain.draining()).toBe(true);
    void drain.begin("SIGTERM");
    await first;

    expect(w.at()).toBeLessThan(1000);
    expect(w.events.at(-1)).toMatch(/^exit\(0\)@/);
    expect(w.lines.find((line) => line.phase === "forced")).toBeDefined();
  });

  test("a failure while leaving does not keep the process from leaving", async () => {
    const w = world();
    const drain = createDrain({
      ...w.options,
      settleMs: 0,
      graceMs: 1000,
      stopListening: () => {
        throw new Error("already stopped");
      },
      closeAll: () => {
        throw new Error("nothing to close");
      },
      cleanup: async () => {
        throw new Error("the listener was already gone");
      },
    });

    await drain.begin("SIGINT");

    expect(w.events.at(-1)).toMatch(/^exit\(0\)@/);
  });
});

describe("against a real server", () => {
  test("a reply still streaming when the signal comes is finished, new connections are refused, and the exit waits for it", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 4; i++) {
                controller.enqueue(new TextEncoder().encode(`piece${i}\n`));
                await Bun.sleep(150);
              }
              controller.close();
            },
          }),
        );
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const started = performance.now();
    const reply = fetch(base).then(async (response) =>
      (await response.text()).trim().split("\n"),
    );
    await Bun.sleep(50);

    let exitedAt = 0;
    const drain = createDrain({
      pending: () => server.pendingRequests,
      stopListening: () => void server.stop(),
      closeAll: () => void server.stop(true),
      cleanup: async () => undefined,
      exit: () => {
        exitedAt = performance.now() - started;
      },
      log: () => undefined,
      settleMs: 100,
      graceMs: 5000,
      pollMs: 20,
    });
    const leaving = drain.begin("SIGTERM");
    // Past the settle time, listening has stopped.
    await Bun.sleep(200);
    const fresh = await fetch(base).then(
      () => "answered",
      () => "refused",
    );
    await leaving;

    expect(fresh).toBe("refused");
    // The whole reply arrived, and the exit came after it ended (about 600 ms in), not before.
    expect(await reply).toEqual(["piece0", "piece1", "piece2", "piece3"]);
    expect(exitedAt).toBeGreaterThan(550);
  });
});
