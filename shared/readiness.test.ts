import { describe, expect, test } from "bun:test";
import { createReadiness } from "./readiness";

describe("readiness", () => {
  test("is ready when the database answers", async () => {
    const ready = createReadiness({
      ping: async () => 1,
      draining: () => false,
    });
    expect(await ready()).toEqual({ ok: true, status: "ok" });
  });

  test("is not ready when the database refuses, and says nothing about why", async () => {
    const ready = createReadiness({
      ping: async () => {
        throw new Error("password authentication failed for user ark");
      },
      draining: () => false,
    });
    const answer = await ready();
    expect(answer).toEqual({ ok: false, status: "unavailable" });
    expect(JSON.stringify(answer)).not.toContain("password");
  });

  test("is not ready when the database does not answer in time, which is how a wedged pool looks", async () => {
    const ready = createReadiness({
      ping: () => new Promise(() => undefined),
      draining: () => false,
      timeoutMs: 50,
    });
    const started = performance.now();
    expect(await ready()).toEqual({ ok: false, status: "unavailable" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("says draining as soon as it has been told to stop, without asking the database", async () => {
    let asked = false;
    const ready = createReadiness({
      ping: async () => {
        asked = true;
      },
      draining: () => true,
    });
    expect(await ready()).toEqual({ ok: false, status: "draining" });
    expect(asked).toBe(false);
  });
});
