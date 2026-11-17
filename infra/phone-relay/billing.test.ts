/**
 * The prepaid phone balance in the relay (#109, v0.1.47): the check before a call is answered, the
 * charges after it, the retries, and the balance passed to the install. blackark.uk is a stand-in
 * that checks the relay's signature; nothing leaves this machine.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type BalanceView,
  createRelay,
  forwardKind,
  type Line,
  sha256Hex,
  twilioSignature,
} from "./relay";

const accountSid = `AC${"1".repeat(32)}`;
const authToken = "test-auth-token";
const billingUrl = "https://blackark.example/checkin/phone/";
const secret = "relay-secret-for-tests-0123456789abcdef";
const callId = (n: number) => `CA${String(n).padStart(32, "0")}`;
const lineToken = "billed-line-token";
const billedLine: Line = {
  name: "billed-shop",
  number: "+302101111111",
  tokenSha256: sha256Hex(lineToken),
  fallback: "+306911111111",
  customerId: "demo-phone",
};
const trialLine: Line = {
  name: "trial-shop",
  number: "+302102222222",
  tokenSha256: sha256Hex("trial-line-token"),
  fallback: "+302103333333",
};

/** What blackark.uk is asked, and what it answers. */
const asked: Record<string, unknown>[] = [];
let state: BalanceView["state"] = "ok";
let reachable = true;

function view(): BalanceView {
  return {
    customerId: "demo-phone",
    balanceMils: state === "ok" ? 30000 : state === "low" ? 5000 : -2000,
    state,
    minutesLeftAtLeast: state === "ok" ? 215 : state === "low" ? 35 : 0,
    topUpUrl:
      "https://blackark.example/checkin/buy/?topup=1&customer=demo-phone",
  };
}

let base = "";
const relay = createRelay({
  accountSid,
  authToken,
  get publicBaseUrl() {
    return base;
  },
  lines: () => [billedLine, trialLine],
  billing: { url: billingUrl, secret },
  fetch: (async (url: string, init: RequestInit) => {
    if (url !== billingUrl) return new Response("{}", { status: 200 });
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    const expected = createHmac("sha256", secret)
      .update(`${headers["x-ark-time"]}.${body}`)
      .digest("hex");
    if (headers["x-ark-signature"] !== expected)
      return new Response("{}", { status: 403 });
    asked.push(JSON.parse(body));
    if (!reachable) return new Response("down", { status: 502 });
    return Response.json(view());
  }) as typeof fetch,
  log: () => {},
});
const server = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
base = `http://localhost:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

beforeEach(() => {
  asked.length = 0;
  state = "ok";
  reachable = true;
});

function signedPost(path: string, params: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(
        authToken,
        `${base}${path}`,
        params,
      ),
    },
    body: new URLSearchParams(params).toString(),
  });
}

const voice = (to: string, n: number) =>
  signedPost("/twilio/voice", {
    AccountSid: accountSid,
    CallSid: callId(n),
    From: "+306912345678",
    To: to,
  }).then((response) => response.text());

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
};

describe("the prepaid phone balance in the relay (#109)", () => {
  test("asks for the balance before answering, and never sends the caller's number", async () => {
    await voice(billedLine.number, 1);
    expect(asked).toEqual([{ action: "balance", customerId: "demo-phone" }]);
    expect(JSON.stringify(asked)).not.toContain("+306912345678");
  });

  test("used up: the caller goes straight to the business's own number, reporting its minutes", async () => {
    state = "empty";
    const twiml = await voice(billedLine.number, 2);
    expect(twiml).not.toContain("<Stream");
    expect(twiml).toContain(
      `<Dial action="${base}/twilio/dialed">+306911111111</Dial>`,
    );
  });

  test("past the debt cap: says the business's number and hangs up", async () => {
    state = "blocked";
    const twiml = await voice(billedLine.number, 3);
    expect(twiml).not.toContain("<Dial");
    expect(twiml).toContain("6 9 1 1 1 1 1 1 1 1");
    expect(twiml).toContain("<Hangup/>");
  });

  test("blackark.uk unreachable: the call is answered as usual", async () => {
    reachable = false;
    const twiml = await voice(billedLine.number, 4);
    expect(twiml).toContain("<Dial");
    expect(twiml).not.toContain("Παρακαλούμε καλέστε στο");
  });

  test("a line with no customer is not billed", async () => {
    const twiml = await voice(trialLine.number, 5);
    expect(asked).toEqual([]);
    expect(twiml).toContain("<Dial>+302103333333</Dial>");
  });

  test("a finished call is charged its incoming seconds, and the install hears the new balance", async () => {
    const desk = new WebSocket(`${base.replace("http", "ws")}/line`, {
      headers: { authorization: `Bearer ${lineToken}` },
    } as never);
    const received: Record<string, unknown>[] = [];
    desk.onmessage = (event) => received.push(JSON.parse(String(event.data)));
    await until(() => received.some((m) => m.type === "phone.balance"));
    received.length = 0;
    asked.length = 0;
    state = "low";

    const status = await signedPost("/twilio/status", {
      AccountSid: accountSid,
      CallSid: callId(6),
      CallStatus: "completed",
      CallDuration: "75",
      To: billedLine.number,
    });
    expect(status.status).toBe(204);
    await until(() => asked.length === 1);
    expect(asked[0]).toEqual({
      action: "charge",
      customerId: "demo-phone",
      callId: callId(6),
      parts: [{ kind: "incoming", seconds: 75 }],
    });
    await until(() => received.some((m) => m.type === "phone.balance"));
    expect(received.find((m) => m.type === "phone.balance")).toMatchObject({
      state: "low",
      minutesLeftAtLeast: 35,
      topUpUrl:
        "https://blackark.example/checkin/buy/?topup=1&customer=demo-phone",
    });
    desk.close();
  });

  test("a call still ringing or unanswered is not charged", async () => {
    await signedPost("/twilio/status", {
      AccountSid: accountSid,
      CallSid: callId(7),
      CallStatus: "no-answer",
      CallDuration: "0",
      To: billedLine.number,
    });
    await Bun.sleep(30);
    expect(asked).toEqual([]);
  });

  test("a forwarded leg is charged at the mobile or landline rate of the number it rang", async () => {
    const answer = await signedPost("/twilio/dialed", {
      AccountSid: accountSid,
      CallSid: callId(8),
      DialCallStatus: "completed",
      DialCallDuration: "61",
      To: billedLine.number,
    });
    expect(await answer.text()).toContain("<Hangup/>");
    await until(() => asked.length === 1);
    expect(asked[0]).toMatchObject({
      callId: callId(8),
      parts: [{ kind: "mobile", seconds: 61 }],
    });
    expect(forwardKind("+302103333333")).toBe("landline");
    expect(forwardKind("+306911111111")).toBe("mobile");
    expect(forwardKind("+447700900000")).toBe("mobile");
  });

  test("a charge blackark.uk did not take is sent again later, the same call id", async () => {
    reachable = false;
    await signedPost("/twilio/status", {
      AccountSid: accountSid,
      CallSid: callId(9),
      CallStatus: "completed",
      CallDuration: "30",
      To: billedLine.number,
    });
    await until(() => relay.state.unsent.length === 1);
    reachable = true;
    asked.length = 0;
    await relay.retryCharges();
    expect(relay.state.unsent.length).toBe(0);
    expect(asked[0]).toMatchObject({
      action: "charge",
      callId: callId(9),
      parts: [{ kind: "incoming", seconds: 30 }],
    });
  });

  test("an unsigned forwarded-leg report is refused", async () => {
    const response = await fetch(`${base}/twilio/dialed`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        AccountSid: accountSid,
        CallSid: callId(10),
        DialCallDuration: "600",
        To: billedLine.number,
      }).toString(),
    });
    expect(response.status).toBe(403);
    expect(asked).toEqual([]);
  });
});
