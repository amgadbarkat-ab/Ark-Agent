/**
 * The phone relay end to end on this machine: a fake Twilio (signed webhooks and a media socket)
 * and a fake install, with the relay in between. Nothing dials Twilio.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createRelay, type Line, sha256Hex, twilioSignature } from "./relay";

const accountSid = `AC${"1".repeat(32)}`;
const authToken = "test-auth-token";
const callId = `CA${"a".repeat(32)}`;
const lineToken = "line-token-for-tests";
const line: Line = {
  name: "demo-shop",
  number: "+302101234567",
  tokenSha256: sha256Hex(lineToken),
  fallback: "+306900000000",
};
const redirects: { url: string; body: string }[] = [];
const logs: string[] = [];

let base = "";
const relay = createRelay({
  accountSid,
  authToken,
  get publicBaseUrl() {
    return base;
  },
  lines: () => [line],
  fetch: (async (url: string, init: RequestInit) => {
    redirects.push({ url, body: String(init.body) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch,
  log: (text) => logs.push(text),
});
const server = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
base = `http://localhost:${server.port}`;
const wsBase = `ws://localhost:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

function signedPost(
  path: string,
  params: Record<string, string>,
  signature?: string,
) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature":
        signature ?? twilioSignature(authToken, `${base}${path}`, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

function open(url: string, headers?: Record<string, string>) {
  const socket = new WebSocket(url, { headers } as never);
  const received: Record<string, unknown>[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("socket error"));
  });
  socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
  return { socket, received, ready };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
};

const voiceParams = {
  AccountSid: accountSid,
  CallSid: callId,
  From: "+306912345678",
  To: line.number,
};

describe("the phone relay (#109)", () => {
  test("refuses an unsigned or wrongly signed webhook", async () => {
    expect((await signedPost("/twilio/voice", voiceParams, "bad")).status).toBe(
      403,
    );
    expect(
      (
        await signedPost("/twilio/voice", {
          ...voiceParams,
          AccountSid: `AC${"2".repeat(32)}`,
        })
      ).status,
    ).toBe(403);
  });

  test("with no install connected, a call goes to the fallback number", async () => {
    const response = await signedPost("/twilio/voice", voiceParams);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<Dial>+306900000000</Dial>");
    expect(body).not.toContain("<Stream");
  });

  test("refuses an install with an unknown line token", async () => {
    const response = await fetch(`${base}/line`, {
      headers: {
        authorization: "Bearer wrong",
        upgrade: "websocket",
        connection: "Upgrade",
      },
    });
    expect(response.status).toBe(401);
  });

  test("carries a call both ways, then hands it over on the install's word", async () => {
    const desk = open(`${wsBase}/line`, {
      authorization: `Bearer ${lineToken}`,
    });
    await desk.ready;
    await until(() => desk.received.some((m) => m.type === "hello"));

    const twiml = await (await signedPost("/twilio/voice", voiceParams)).text();
    expect(twiml).toContain("<Connect><Stream");
    const key = /name="key" value="([^"]+)"/.exec(twiml)?.[1] ?? "";
    expect(key).not.toBe("");

    // A media socket with a made-up key is closed.
    const stranger = open(`${wsBase}/twilio/media`);
    await stranger.ready;
    stranger.socket.send(
      JSON.stringify({
        event: "start",
        start: {
          callSid: callId,
          streamSid: "MZ1",
          customParameters: { key: "made-up" },
        },
      }),
    );
    await until(() => stranger.socket.readyState === WebSocket.CLOSED);

    const twilio = open(`${wsBase}/twilio/media`);
    await twilio.ready;
    twilio.socket.send(JSON.stringify({ event: "connected" }));
    twilio.socket.send(
      JSON.stringify({
        event: "start",
        start: { callSid: callId, streamSid: "MZ1", customParameters: { key } },
      }),
    );
    await until(() => desk.received.some((m) => m.type === "call.start"));
    expect(desk.received.find((m) => m.type === "call.start")).toMatchObject({
      callId,
      from: "+306912345678",
    });

    // The key is single use.
    expect(relay.state.pending.has(key)).toBe(false);

    twilio.socket.send(
      JSON.stringify({ event: "media", media: { payload: "AAAA" } }),
    );
    await until(() => desk.received.some((m) => m.type === "media"));
    expect(desk.received.find((m) => m.type === "media")).toMatchObject({
      callId,
      payload: "AAAA",
    });

    desk.socket.send(
      JSON.stringify({ type: "media", callId, payload: "BBBB" }),
    );
    await until(() => twilio.received.some((m) => m.event === "media"));
    expect(twilio.received.find((m) => m.event === "media")).toEqual({
      event: "media",
      streamSid: "MZ1",
      media: { payload: "BBBB" },
    });

    // The install asks for a hand-over; the number comes from the lines file, not from the install.
    desk.socket.send(
      JSON.stringify({ type: "transfer", callId, to: "+15550000000" }),
    );
    await until(() => redirects.length > 0);
    expect(redirects[0]?.url).toContain(`/Calls/${callId}.json`);
    expect(decodeURIComponent(redirects[0]?.body ?? "")).toContain(
      "<Dial>+306900000000</Dial>",
    );
    expect(decodeURIComponent(redirects[0]?.body ?? "")).not.toContain(
      "15550000000",
    );

    twilio.socket.send(JSON.stringify({ event: "stop" }));
    await until(() => desk.received.some((m) => m.type === "call.end"));
    expect(logs.some((text) => text.includes("+3069"))).toBe(false);
    desk.socket.close();
    twilio.socket.close();
  });
});
