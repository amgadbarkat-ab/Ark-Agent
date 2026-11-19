/**
 * What relaying a call's audio costs the line's object per message, measured through the stand-ins
 * (Bun's JavaScriptCore, not workerd's V8, so a rough figure; the stand-in sockets' own cost is in it,
 * so it is an upper bound for the relay's part). Workers Free allows 10 ms of CPU per invocation.
 * The figure is printed; README.md quotes it.
 */
import { afterAll, expect, test } from "bun:test";
import { callId, demoLine, setup, until } from "./harness";

const t = setup({ billing: false });
afterAll(() => t.stop());

test("one media message each way costs far less than Workers Free's 10 ms of CPU", async () => {
  await t.admin("add", { line: demoLine });
  const desk = await t.connectedDesk();
  const twiml = await t.voice(demoLine, 90);
  const twilio = await t.media(twiml);
  t.start(twilio, twiml, 90);
  await until(() => desk.messages().some((m) => m.type === "call.start"));

  // 20 ms of μ-law at 8 kHz is 160 bytes: 216 characters of base64, as Twilio sends.
  const payload = btoa(String.fromCharCode(...new Uint8Array(160).fill(0xff)));
  const n = 5000;
  const inbound = JSON.stringify({
    event: "media",
    streamSid: "MZ1",
    media: { track: "inbound", chunk: "1", timestamp: "20", payload },
  });
  const outbound = JSON.stringify({
    type: "media",
    callId: callId(90),
    payload,
  });
  const before = desk.received.length;
  const beforeTwilio = twilio.received.length;
  const started = performance.now();
  for (let i = 0; i < n; i++) {
    twilio.send(inbound);
    desk.send(outbound);
  }
  await until(
    () =>
      desk.received.length - before >= n &&
      twilio.received.length - beforeTwilio >= n,
    20_000,
  );
  const perMessageMs = (performance.now() - started) / (2 * n);
  console.log(
    `audio relay: ${(perMessageMs * 1000).toFixed(1)} µs per media message (stand-ins, Bun), ${2 * n} messages`,
  );
  expect(perMessageMs).toBeLessThan(1);
});
