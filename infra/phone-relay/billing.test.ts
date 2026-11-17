/**
 * The prepaid phone balance in the relay (#109, v0.1.47; Amgad 17 Nov): never below zero. Each test
 * runs a fresh relay with a stand-in blackark.uk (it checks the relay's signature and keeps the
 * balance) and a stand-in Twilio API, with a "minute" of 300 ms. Nothing leaves this machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type CallPart,
  costOf,
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
const rates = { incoming: 78, landline: 88, mobile: 139 };
const callId = (n: number) => `CA${String(n).padStart(32, "0")}`;
const lineToken = "billed-line-token";
/** Billed, its install connected in tests that need it. */
const billedLine: Line = {
  name: "billed-shop",
  number: "+302101111111",
  tokenSha256: sha256Hex(lineToken),
  fallback: "+306911111111",
  customerId: "demo-phone",
};
/** Billed, the same customer, never connected: calls go to its (mobile) fallback. */
const offlineLine: Line = {
  name: "billed-offline",
  number: "+302104444444",
  tokenSha256: sha256Hex("offline-line-token"),
  fallback: "+306944444444",
  customerId: "demo-phone",
};
const trialLine: Line = {
  name: "trial-shop",
  number: "+302102222222",
  tokenSha256: sha256Hex("trial-line-token"),
  fallback: "+302103333333",
};

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup(options: { balance: number; reachable?: boolean }) {
  const asked: Record<string, unknown>[] = [];
  const alerts: { subject: string; body: string }[] = [];
  const twilio: string[] = [];
  const bank = {
    balance: options.balance,
    reachable: options.reachable ?? true,
  };
  const view = () => ({
    customerId: "demo-phone",
    balanceMils: bank.balance,
    state:
      bank.balance < rates.incoming
        ? "empty"
        : bank.balance <= 8340
          ? "low"
          : "ok",
    minutesLeftAtLeast: Math.floor(Math.max(0, bank.balance) / rates.mobile),
    topUpUrl:
      "https://blackark.example/checkin/buy/?topup=1&customer=demo-phone",
    rates,
  });
  let base = "";
  const relay = createRelay({
    accountSid,
    authToken,
    get publicBaseUrl() {
      return base;
    },
    lines: () => [billedLine, offlineLine, trialLine],
    billing: { url: billingUrl, secret, minuteMs: 300, marginMs: 100 },
    fetch: (async (url: string, init: RequestInit) => {
      if (url !== billingUrl) {
        twilio.push(String(init.body));
        return new Response("{}", { status: 200 });
      }
      const headers = init.headers as Record<string, string>;
      const body = String(init.body);
      const expected = createHmac("sha256", secret)
        .update(`${headers["x-ark-time"]}.${body}`)
        .digest("hex");
      if (headers["x-ark-signature"] !== expected)
        return new Response("{}", { status: 403 });
      const request = JSON.parse(body);
      asked.push(request);
      if (!bank.reachable) return new Response("down", { status: 502 });
      if (request.action === "charge") {
        bank.balance = Math.max(
          0,
          bank.balance - costOf(request.parts as CallPart[], rates),
        );
      }
      return Response.json(view());
    }) as typeof fetch,
    log: () => {},
    alert: async (subject, body) => {
      alerts.push({ subject, body });
    },
  });
  const server = Bun.serve({
    port: 0,
    fetch: relay.fetch,
    websocket: relay.websocket,
  });
  base = `http://localhost:${server.port}`;
  stops.push(() => void server.stop(true));

  const post = (path: string, params: Record<string, string>) =>
    fetch(`${base}${path}`, {
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
  const voice = (line: Line, n: number) =>
    post("/twilio/voice", {
      AccountSid: accountSid,
      CallSid: callId(n),
      From: "+306912345678",
      To: line.number,
    }).then((response) => response.text());
  const status = (line: Line, n: number, callStatus: string, seconds: number) =>
    post("/twilio/status", {
      AccountSid: accountSid,
      CallSid: callId(n),
      CallStatus: callStatus,
      CallDuration: String(seconds),
      To: line.number,
    });
  async function desk() {
    const socket = new WebSocket(`${base.replace("http", "ws")}/line`, {
      headers: { authorization: `Bearer ${lineToken}` },
    } as never);
    const received: Record<string, unknown>[] = [];
    socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
    stops.push(() => socket.close());
    await until(() => received.some((m) => m.type === "phone.balance"));
    return received;
  }
  return {
    relay,
    asked,
    alerts,
    twilio,
    bank,
    post,
    voice,
    status,
    desk,
    base,
  };
}

const until = async (check: () => boolean, ms = 2000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
};

describe("the prepaid phone balance in the relay (#109)", () => {
  test("asks for the balance before answering, never sending the caller's number", async () => {
    const t = setup({ balance: 10000 });
    await t.desk();
    t.asked.length = 0;
    const twiml = await t.voice(billedLine, 1);
    expect(t.asked).toEqual([{ action: "balance", customerId: "demo-phone" }]);
    expect(JSON.stringify(t.asked)).not.toContain("+306912345678");
    expect(twiml).toContain("<Connect><Stream");
    // A billed call is put through only by a transfer that sets its minute aside first.
    expect(twiml).toContain("</Connect><Hangup/>");
    expect(t.relay.state.meters.get(callId(1))?.reserved).toBe(78);
  });

  test("a balance that cannot pay a first minute: not answered (busy, which Twilio does not bill)", async () => {
    const t = setup({ balance: 77 });
    expect(await t.voice(billedLine, 2)).toContain('<Reject reason="busy"/>');
    expect(t.relay.state.meters.size).toBe(0);
  });

  test("blackark.uk unreachable and no balance known: busy, and BlackArk is alerted", async () => {
    const t = setup({ balance: 10000, reachable: false });
    expect(await t.voice(billedLine, 3)).toContain('<Reject reason="busy"/>');
    await until(() => t.alerts.length === 1);
    expect(t.alerts[0]?.subject).toContain("blackark.uk is not answering");
  });

  test("blackark.uk unreachable: ONE call on the last balance known, then busy until it answers again; one alert", async () => {
    const t = setup({ balance: 10000 });
    await t.desk(); // the relay now knows the balance
    t.bank.reachable = false;
    expect(await t.voice(billedLine, 20)).toContain("<Connect>");
    // The one call is still held to that balance, minute by minute.
    expect(t.relay.state.meters.get(callId(20))?.reserved).toBe(78);
    expect(await t.voice(billedLine, 21)).toContain('<Reject reason="busy"/>');
    expect(await t.voice(billedLine, 22)).toContain('<Reject reason="busy"/>');
    await until(() => t.alerts.length === 1);
    expect(t.alerts[0]?.body).toContain("ONE call per customer");
    expect(t.alerts[0]?.body).not.toContain("+3069");
    // blackark.uk answers again: calls are answered as usual, and no second alert.
    t.bank.reachable = true;
    expect(await t.voice(billedLine, 23)).toContain("<Connect>");
    // A new outage within the hour is not alerted again.
    t.bank.reachable = false;
    expect(await t.voice(billedLine, 24)).toContain("<Connect>");
    expect(await t.voice(billedLine, 25)).toContain('<Reject reason="busy"/>');
    await Bun.sleep(30);
    expect(t.alerts.length).toBe(1);
  });

  test("a line with no customer is not billed", async () => {
    const t = setup({ balance: 0 });
    const twiml = await t.voice(trialLine, 4);
    expect(t.asked).toEqual([]);
    expect(twiml).toContain("<Dial>+302103333333</Dial>");
  });

  test("each next minute is set aside before it starts; when it cannot be, the call hears one sentence and ends", async () => {
    const t = setup({ balance: 200 });
    const received = await t.desk();
    await t.voice(billedLine, 5);
    // 200 pays two minutes at 0.078 (156) but not a third.
    await until(() => t.relay.state.meters.get(callId(5))?.reserved === 156);
    await until(() =>
      t.twilio.some((body) => body.includes("%CF%84%CE%B5%CE%BB%CE%B5%CE%AF")),
    );
    const ended = decodeURIComponent(
      (t.twilio.find((body) => body.includes("Twiml")) ?? "").replace(
        /\+/g,
        " ",
      ),
    );
    expect(ended).toContain("Ο διαθέσιμος χρόνος της γραμμής τελείωσε");
    expect(ended).toContain("<Hangup/>");
    expect(
      received.some((m) => m.type === "call.ending" && m.callId === callId(5)),
    ).toBe(true);
    // Nothing more is set aside after the cut.
    await Bun.sleep(400);
    expect(t.relay.state.meters.get(callId(5))?.reserved).toBe(156);
  });

  test("calls at the same time share one balance: together they never go past it", async () => {
    const t = setup({ balance: 160 });
    await t.desk();
    expect(await t.voice(billedLine, 6)).toContain("<Connect>");
    expect(await t.voice(billedLine, 7)).toContain("<Connect>");
    expect(await t.voice(billedLine, 8)).toContain('<Reject reason="busy"/>');
  });

  test("with no install, the forwarded leg's minute is set aside too, and its action reports the minutes", async () => {
    const t = setup({ balance: 216 });
    // 0.078 + 0.139 = 217: one mil short.
    expect(await t.voice(offlineLine, 9)).toContain('<Reject reason="busy"/>');
    t.bank.balance = 217;
    const twiml = await t.voice(offlineLine, 10);
    expect(twiml).toContain(
      `<Dial action="${t.base}/twilio/dialed">+306944444444</Dial>`,
    );
    expect(t.relay.state.meters.get(callId(10))?.reserved).toBe(217);
  });

  test("a finished call is charged its seconds, what it set aside is let go, and the install hears the new balance", async () => {
    const t = setup({ balance: 10000 });
    const received = await t.desk();
    await t.voice(billedLine, 11);
    received.length = 0;
    t.asked.length = 0;
    expect((await t.status(billedLine, 11, "completed", 75)).status).toBe(204);
    await until(() => t.asked.length === 1);
    expect(t.asked[0]).toEqual({
      action: "charge",
      customerId: "demo-phone",
      callId: callId(11),
      parts: [{ kind: "incoming", seconds: 75 }],
    });
    await until(() => !t.relay.state.meters.has(callId(11)));
    await until(() => received.some((m) => m.type === "phone.balance"));
    expect(received.find((m) => m.type === "phone.balance")).toMatchObject({
      balanceMils: 10000 - 156,
      topUpUrl:
        "https://blackark.example/checkin/buy/?topup=1&customer=demo-phone",
    });
  });

  test("an unanswered call is not charged, and lets go of what it set aside", async () => {
    const t = setup({ balance: 10000 });
    await t.voice(offlineLine, 12);
    t.asked.length = 0;
    await t.status(offlineLine, 12, "no-answer", 0);
    await Bun.sleep(30);
    expect(t.asked).toEqual([]);
    expect(t.relay.state.meters.has(callId(12))).toBe(false);
  });

  test("a forwarded leg is charged at the rate of the number it rang", async () => {
    const t = setup({ balance: 10000 });
    await t.voice(offlineLine, 13);
    t.asked.length = 0;
    const answer = await t.post("/twilio/dialed", {
      AccountSid: accountSid,
      CallSid: callId(13),
      DialCallStatus: "completed",
      DialCallDuration: "61",
      To: offlineLine.number,
    });
    expect(await answer.text()).toContain("<Hangup/>");
    await until(() => t.asked.length === 1);
    expect(t.asked[0]).toMatchObject({
      callId: callId(13),
      parts: [{ kind: "mobile", seconds: 61 }],
    });
    // The forwarded minute set aside is let go once charged; the incoming one stays until the end.
    await until(() => t.relay.state.meters.get(callId(13))?.reserved === 78);
    expect(forwardKind("+302103333333")).toBe("landline");
    expect(forwardKind("+306911111111")).toBe("mobile");
    expect(forwardKind("+447700900000")).toBe("mobile");
  });

  test("a charge blackark.uk did not take is held against the balance and sent again later", async () => {
    const t = setup({ balance: 200 });
    await t.desk();
    await t.voice(billedLine, 14);
    t.bank.reachable = false;
    await t.status(billedLine, 14, "completed", 90);
    await until(() => t.relay.state.unsent.length === 1);
    // 200 less the unsent 2 minutes (156) cannot pay a new call's first minute.
    t.bank.reachable = true;
    expect(t.relay.state.meters.has(callId(14))).toBe(false);
    expect(await t.voice(billedLine, 15)).toContain('<Reject reason="busy"/>');
    t.asked.length = 0;
    await t.relay.retryCharges();
    expect(t.relay.state.unsent.length).toBe(0);
    expect(t.asked[0]).toMatchObject({
      action: "charge",
      callId: callId(14),
      parts: [{ kind: "incoming", seconds: 90 }],
    });
  });

  test("an unsigned forwarded-leg report is refused", async () => {
    const t = setup({ balance: 10000 });
    const response = await fetch(`${t.base}/twilio/dialed`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        AccountSid: accountSid,
        CallSid: callId(16),
        DialCallDuration: "600",
        To: offlineLine.number,
      }).toString(),
    });
    expect(response.status).toBe(403);
    expect(t.asked).toEqual([]);
  });

  test("what parts of a call cost: whole minutes at each part's rate", () => {
    expect(
      costOf(
        [
          { kind: "incoming", seconds: 75 },
          { kind: "mobile", seconds: 61 },
          { kind: "landline", seconds: 0 },
        ],
        rates,
      ),
    ).toBe(2 * 78 + 2 * 139);
  });
});
