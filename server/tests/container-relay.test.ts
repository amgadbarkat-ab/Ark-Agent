import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { containerRelayCheck } from "../src/agents/container-relay";

test("no relay named: the containers always reach the server", async () => {
  expect(await containerRelayCheck(undefined)()).toBe(true);
  expect(await containerRelayCheck("not an address")()).toBe(true);
});

test("a named relay is up while something listens there, and down once it is gone (#109)", async () => {
  const listener = createServer((socket) => socket.end());
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const port = (listener.address() as { port: number }).port;
  let clock = 0;
  const check = containerRelayCheck(`127.0.0.1:${port}`, { now: () => clock });
  expect(await check()).toBe(true);
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  // Trusted for a few seconds, then asked again.
  expect(await check()).toBe(true);
  clock += 6_000;
  expect(await check()).toBe(false);
});
