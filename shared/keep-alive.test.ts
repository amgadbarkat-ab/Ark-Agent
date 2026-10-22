import { expect, test } from "bun:test";
import { KEEP_ALIVE_FRAME, keepAlive } from "./keep-alive";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("sends a comment line every so often, and stops when told to", async () => {
  const sent: string[] = [];
  const stop = keepAlive((frame) => sent.push(frame), 10);
  await sleep(55);
  stop();
  const seen = sent.length;
  expect(seen).toBeGreaterThanOrEqual(2);
  await sleep(40);
  expect(sent).toHaveLength(seen);
  expect(sent.every((frame) => frame === KEEP_ALIVE_FRAME)).toBe(true);
});

test("is a comment, which a server-sent-events reader ignores", () => {
  expect(KEEP_ALIVE_FRAME.startsWith(":")).toBe(true);
  expect(KEEP_ALIVE_FRAME.endsWith("\n\n")).toBe(true);
});

test("ends the beat, not the run, when the stream has gone", async () => {
  let calls = 0;
  keepAlive(() => {
    calls += 1;
    throw new TypeError("Invalid state: Controller is already closed");
  }, 5);
  await sleep(40);
  expect(calls).toBe(1);
});
