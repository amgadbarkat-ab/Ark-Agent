import { afterEach, describe, expect, test } from "bun:test";
import { SECURITY_ENABLED, startTarget, type Target } from "./harness";

/**
 * Leaving without cutting anybody off, against the real server process.
 *
 * Every deploy tells every pod to stop. A server that exits at once ends every reply being streamed to
 * somebody; this one keeps serving while the platform takes it out of rotation, stops listening, waits
 * for what is under way, and only then closes what is left (shared/drain.ts).
 */

const run = SECURITY_ENABLED ? describe : describe.skip;

let target: Target | undefined;
afterEach(async () => {
  await target?.stop();
  target = undefined;
});

/** A request whose body arrives slowly, so that the server is mid-request when it is told to stop. */
function slowRequest(base: string, cookie: string, seconds: number) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('{"instructions":"'));
      await Bun.sleep(seconds * 1000);
      controller.enqueue(encoder.encode('slow"}'));
      controller.close();
    },
  });
  return fetch(`${base}/api/settings/instructions`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body,
    // Required by the runtime for a streamed body.
    duplex: "half",
  } as RequestInit).then(
    (response) => response.status,
    () => -1,
  );
}

run("leaving", () => {
  test("a server with nothing under way leaves promptly, with a clean exit and a record of why", async () => {
    target = await startTarget({
      env: { SHUTDOWN_SETTLE_SECONDS: "1", SHUTDOWN_GRACE_SECONDS: "10" },
    });

    // Ready while it is serving, and not asked for anything.
    const before = await fetch(`${target.url}/ready`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ status: "ok" });

    const leaving = target.terminate();
    // Within the settle second it is still answering, and says it is leaving, so what routes to it
    // stops without waiting to notice.
    await Bun.sleep(300);
    const during = await fetch(`${target.url}/ready`);
    expect(during.status).toBe(503);
    expect(await during.json()).toEqual({ status: "draining" });
    expect((await fetch(`${target.url}/health`)).status).toBe(200);
    const { code, milliseconds } = await leaving;

    expect(code).toBe(0);
    // The settle second, and not the ten of the grace: nothing was waiting.
    expect(milliseconds).toBeGreaterThan(800);
    expect(milliseconds).toBeLessThan(4000);
    const log = await target.log();
    for (const phase of ["draining", "idle", "exit"]) {
      expect(log).toContain(
        `"type":"shutdown","signal":"SIGTERM","phase":"${phase}"`,
      );
    }
  }, 60_000);

  test("a request under way when the signal comes is finished, new ones are refused, and the exit waits", async () => {
    target = await startTarget({
      env: { SHUTDOWN_SETTLE_SECONDS: "1", SHUTDOWN_GRACE_SECONDS: "20" },
    });
    const pending = slowRequest(target.url, target.a.cookie, 3);
    await Bun.sleep(400);

    const leaving = target.terminate();
    // Past the settle second the server has stopped listening.
    await Bun.sleep(1800);
    const fresh = await fetch(`${target.url}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      () => "answered",
      () => "refused",
    );
    const { code, milliseconds } = await leaving;

    expect(fresh).toBe("refused");
    // Answered in full, not cut off.
    expect(await pending).toBe(200);
    expect(code).toBe(0);
    // It left after the request ended (about three seconds in), not at the settle second.
    expect(milliseconds).toBeGreaterThan(2400);
    expect(await target.log()).toContain('"phase":"idle"');
  }, 60_000);

  test("a request that would never end is cut off when the grace is up, and the log says so", async () => {
    target = await startTarget({
      env: { SHUTDOWN_SETTLE_SECONDS: "0", SHUTDOWN_GRACE_SECONDS: "2" },
    });
    const pending = slowRequest(target.url, target.a.cookie, 30);
    await Bun.sleep(400);

    const { code, milliseconds } = await target.terminate();

    expect(code).toBe(0);
    expect(milliseconds).toBeGreaterThan(1800);
    expect(milliseconds).toBeLessThan(6000);
    expect(await target.log()).toContain('"phase":"forced"');
    expect(await pending).not.toBe(200);
  }, 60_000);
});
