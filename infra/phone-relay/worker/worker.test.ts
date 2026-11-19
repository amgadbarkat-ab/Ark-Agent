/**
 * The Workers phone relay under `bun test`, against stand-ins for the runtime (`stand-ins.ts`), for
 * blackark.uk and for Twilio (`harness.ts`). Nothing leaves this machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Line } from "../core";
import {
  accountSid,
  authToken,
  base,
  caller,
  callId,
  decoded,
  demoLine,
  hmacSha1,
  mailServer,
  setup,
  until,
} from "./harness";
import type { FakeSocket } from "./stand-ins";

const made: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const t of made.splice(0)) {
    t.stop();
    // No caller's number in any log line, in any test.
    expect(t.logs.filter((line) => line.includes("+3069"))).toEqual([]);
  }
});
function fresh(options: Parameters<typeof setup>[0] = {}) {
  const t = setup(options);
  made.push(t);
  return t;
}

describe("Twilio's webhooks on the Workers relay", () => {
  test("a signed webhook is taken; an unsigned one, or one for another account, is refused", async () => {
    const t = fresh({ billing: false });
    expect((await t.admin("add", { line: demoLine })).status).toBe(200);
    const params = {
      AccountSid: accountSid,
      CallSid: callId(1),
      From: caller,
      To: demoLine.number,
    };
    expect((await t.post("/twilio/voice", params)).status).toBe(200);
    expect((await t.post("/twilio/voice", params, "bad")).status).toBe(403);
    const other = { ...params, AccountSid: `AC${"2".repeat(32)}` };
    expect(
      (
        await t.post(
          "/twilio/voice",
          other,
          await hmacSha1(authToken, `${base}/twilio/voice`, other),
        )
      ).status,
    ).toBe(403);
  });

  test("with no install connected, a call goes to the fallback number", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const twiml = await t.voice(demoLine, 2);
    expect(twiml).toContain("<Dial>+306900000000</Dial>");
    expect(twiml).not.toContain("<Stream");
  });

  test("a number that is no line here hears the Greek sorry", async () => {
    const t = fresh({ billing: false });
    expect(
      await t.voice({ ...demoLine, number: "+302109999999" }, 3),
    ).toContain('language="el-GR"');
  });
});

describe("the install's socket", () => {
  test("an unknown line token is refused", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const refused = (await t.desk("wrong")) as Response;
    expect(refused.status).toBe(401);
  });

  test("a known token connects and hears hello for its line", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const desk = await t.connectedDesk();
    expect(desk.messages()[0]).toEqual({
      type: "hello",
      line: "demo-shop",
      number: "+302101234567",
    });
  });
});

describe("deployed before Twilio exists (19 Nov: Twilio waits for the first customer)", () => {
  test("lines can be added and installs connect; only Twilio's routes wait", async () => {
    const t = fresh({ billing: false, twilio: false });
    expect((await t.relay("/health")).status).toBe(200);
    expect((await t.admin("add", { line: demoLine })).status).toBe(200);
    const desk = await t.connectedDesk();
    expect(desk.messages()[0]).toMatchObject({
      type: "hello",
      line: "demo-shop",
    });
    const voice = await t.relay("/twilio/voice", { method: "POST", body: "" });
    expect(voice.status).toBe(503);
  });
});

describe("a call on the Workers relay", () => {
  test("is carried both ways, the media key works once, and the hand-over uses the line's fallback", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const desk = await t.connectedDesk();
    const twiml = await t.voice(demoLine, 10);
    expect(twiml).toContain(
      '<Connect><Stream url="wss://blackark-phone.example.workers.dev/twilio/media/demo-shop">',
    );

    // A media socket with a made-up key is closed.
    const stranger = await t.media(twiml);
    stranger.send(
      JSON.stringify({
        event: "start",
        start: {
          callSid: callId(10),
          streamSid: "MZ0",
          customParameters: { key: "made-up" },
        },
      }),
    );
    await until(() => stranger.readyState === 3);

    const twilio = await t.media(twiml);
    t.start(twilio, twiml, 10);
    await until(() => desk.messages().some((m) => m.type === "call.start"));
    expect(desk.messages().find((m) => m.type === "call.start")).toEqual({
      type: "call.start",
      callId: callId(10),
      from: caller,
      to: demoLine.number,
    });

    // The key is single use: a second stream with it is closed.
    const again = await t.media(twiml);
    t.start(again, twiml, 10, "MZ2");
    await until(() => again.readyState === 3);

    twilio.send(JSON.stringify({ event: "media", media: { payload: "AAAA" } }));
    await until(() => desk.messages().some((m) => m.type === "media"));
    expect(desk.messages().find((m) => m.type === "media")).toEqual({
      type: "media",
      callId: callId(10),
      payload: "AAAA",
    });
    desk.send(
      JSON.stringify({ type: "media", callId: callId(10), payload: "BBBB" }),
    );
    await until(() => twilio.messages().some((m) => m.event === "media"));
    expect(twilio.messages().find((m) => m.event === "media")).toEqual({
      event: "media",
      streamSid: "MZ1",
      media: { payload: "BBBB" },
    });

    // The install asks for a hand-over; the number is the line's, not one the install sent.
    desk.send(
      JSON.stringify({
        type: "transfer",
        callId: callId(10),
        to: "+15550000000",
      }),
    );
    await until(() => t.twilio.length > 0);
    expect(t.twilio[0]?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callId(10)}.json`,
    );
    expect(decoded(t.twilio[0]?.body ?? "")).toContain(
      "<Dial>+306900000000</Dial>",
    );
    expect(decoded(t.twilio[0]?.body ?? "")).not.toContain("15550000000");

    twilio.send(JSON.stringify({ event: "stop" }));
    await until(() => desk.messages().some((m) => m.type === "call.end"));
    twilio.close();
    await Bun.sleep(10);
    expect(desk.messages().filter((m) => m.type === "call.end").length).toBe(1);
    expect(t.logs.some((line) => line.includes("started"))).toBe(true);
  });

  test("the install's heartbeat is answered by the runtime, without waking the line's object", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const desk = await t.connectedDesk();
    const state = t.env.LINE.state("demo-shop");
    const woken = state.messages;
    desk.send('{"type":"ping"}');
    await until(() => desk.received.includes('{"type":"pong"}'));
    expect(state.messages).toBe(woken);
  });

  test("a call goes on after the line's object is evicted (hibernation)", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const desk = await t.connectedDesk();
    const twiml = await t.voice(demoLine, 11);
    const twilio = await t.media(twiml);
    t.start(twilio, twiml, 11);
    await until(() => desk.messages().some((m) => m.type === "call.start"));
    t.env.LINE.evict("demo-shop");
    desk.send(
      JSON.stringify({ type: "media", callId: callId(11), payload: "CCCC" }),
    );
    await until(() => twilio.messages().some((m) => m.event === "media"));
    twilio.send(JSON.stringify({ event: "media", media: { payload: "DDDD" } }));
    await until(() => desk.messages().some((m) => m.payload === "DDDD"));
  });

  test("when the install drops mid-call, the caller goes to the fallback", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const desk = await t.connectedDesk();
    const twiml = await t.voice(demoLine, 12);
    const twilio = await t.media(twiml);
    t.start(twilio, twiml, 12);
    await until(() => desk.messages().some((m) => m.type === "call.start"));
    desk.close(1006, "gone");
    await until(() => t.twilio.length > 0);
    expect(decoded(t.twilio[0]?.body ?? "")).toContain(
      "<Dial>+306900000000</Dial>",
    );
  });

  test("a newer install for the line replaces the older one (code 4000)", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const older = await t.connectedDesk();
    await t.connectedDesk();
    await until(() => older.readyState === 3);
    expect(older.closed?.code).toBe(4000);
  });
});

const billedLine: Line = {
  ...demoLine,
  name: "billed-shop",
  number: "+302101111111",
  fallback: "+306911111111",
};

/** A billed line, its install connected (the relay then knows the balance). */
async function billed(options: Parameters<typeof setup>[0] = {}) {
  const t = fresh({ timing: { minuteMs: 300, marginMs: 100 }, ...options });
  await t.admin("add", { line: billedLine });
  await t.admin("bill", { name: "billed-shop", customerId: "demo-phone" });
  return t;
}
async function deskWithBalance(t: ReturnType<typeof setup>) {
  const desk = await t.connectedDesk();
  await until(() => desk.messages().some((m) => m.type === "phone.balance"));
  return desk;
}

describe("the prepaid balance on the Workers relay", () => {
  test("a balance that cannot pay a first minute: busy (not answered, so Twilio does not bill it)", async () => {
    const t = await billed({ balance: 77 });
    await deskWithBalance(t);
    expect(await t.voice(billedLine, 20)).toContain('<Reject reason="busy"/>');
    // With no install, the first minute includes the forwarded leg (78 + 139 mobile).
    const offline = await billed({ balance: 216 });
    expect(await offline.voice(billedLine, 21)).toContain(
      '<Reject reason="busy"/>',
    );
    offline.bank.balance = 217;
    expect(await offline.voice(billedLine, 22)).toContain(
      `<Dial action="${base}/twilio/dialed">+306911111111</Dial>`,
    );
  });

  test("the balance goes to the install on every incoming call, so a top-up shows with the next call", async () => {
    const t = await billed({ balance: 0 });
    const desk = await deskWithBalance(t);
    expect(desk.messages().at(-1)).toMatchObject({ state: "empty" });
    t.bank.balance = 23_400;
    t.asked.length = 0;
    const twiml = await t.voice(billedLine, 23);
    expect(twiml).toContain("<Connect><Stream");
    // A billed call is put through only by a transfer that first sets its minute aside.
    expect(twiml).toContain("</Connect><Hangup/>");
    expect(t.asked).toEqual([{ action: "balance", customerId: "demo-phone" }]);
    expect(JSON.stringify(t.asked)).not.toContain(caller);
    await until(() =>
      desk
        .messages()
        .some((m) => m.type === "phone.balance" && m.balanceMils === 23_400),
    );
  });

  test("a call answered is charged per part: its incoming seconds, then the forwarded leg at the rate of the number it rang", async () => {
    const t = await billed({ balance: 10_000 });
    const desk = await deskWithBalance(t);
    const twiml = await t.voice(billedLine, 24);
    const twilio = await t.media(twiml);
    t.start(twilio, twiml, 24);
    await until(() => desk.messages().some((m) => m.type === "call.start"));
    desk.send(JSON.stringify({ type: "transfer", callId: callId(24) }));
    await until(() => t.twilio.length > 0);
    expect(decoded(t.twilio[0]?.body ?? "")).toContain(
      `<Dial action="${base}/twilio/dialed">+306911111111</Dial>`,
    );
    t.asked.length = 0;
    expect(await (await t.dialed(billedLine, 24, 61)).text()).toContain(
      "<Hangup/>",
    );
    expect((await t.status(billedLine, 24, "completed", 75)).status).toBe(204);
    expect(t.asked).toEqual([
      {
        action: "charge",
        customerId: "demo-phone",
        callId: callId(24),
        parts: [{ kind: "mobile", seconds: 61 }],
      },
      {
        action: "charge",
        customerId: "demo-phone",
        callId: callId(24),
        parts: [{ kind: "incoming", seconds: 75 }],
      },
    ]);
    // 2 mobile minutes and 2 incoming ones; the install hears the new balance.
    expect(t.bank.balance).toBe(10_000 - 2 * 139 - 2 * 78);
    await until(() =>
      desk.messages().some((m) => m.balanceMils === 10_000 - 434),
    );
  });

  test("an unanswered call is not charged", async () => {
    const t = await billed({ balance: 10_000 });
    await t.voice(billedLine, 25);
    t.asked.length = 0;
    await t.status(billedLine, 25, "no-answer", 0);
    expect(t.asked).toEqual([]);
  });

  test("the next minute is set aside before it starts; when it cannot be, the caller hears one Greek sentence and the call ends", async () => {
    // 200 pays two minutes at 78 (156), not a third.
    const t = await billed({ balance: 200 });
    const desk = await deskWithBalance(t);
    const twiml = await t.voice(billedLine, 26);
    const twilio = await t.media(twiml);
    t.start(twilio, twiml, 26);
    // At 200 ms the second minute is set aside: what is left (44) cannot pay another call.
    await Bun.sleep(250);
    expect(t.twilio).toEqual([]);
    expect(await t.voice(billedLine, 27)).toContain('<Reject reason="busy"/>');
    // At 500 ms the third cannot be: the call is cut before it starts.
    await until(() => t.twilio.length > 0);
    const ended = decoded(t.twilio[0]?.body ?? "");
    expect(t.twilio[0]?.url).toContain(`/Calls/${callId(26)}.json`);
    expect(ended).toContain("Ο διαθέσιμος χρόνος της γραμμής τελείωσε");
    expect(ended).toContain("<Hangup/>");
    expect(
      desk
        .messages()
        .some((m) => m.type === "call.ending" && m.callId === callId(26)),
    ).toBe(true);
    // Nothing more happens to it.
    await Bun.sleep(400);
    expect(t.twilio.length).toBe(1);
  });

  test("a low or used-up balance is asked again by alarm with no call; one that is fine is not", async () => {
    const t = await billed({
      balance: 0,
      timing: { minuteMs: 300, marginMs: 100, refreshMs: 150 },
    });
    const desk = await deskWithBalance(t);
    t.bank.balance = 23_400;
    await until(() =>
      desk.messages().some((m) => m.balanceMils === 23_400 && m.state === "ok"),
    );
    // Now "ok": no more asking until a call or a charge says otherwise.
    await Bun.sleep(50);
    t.asked.length = 0;
    await Bun.sleep(400);
    expect(t.asked).toEqual([]);
  });

  test("blackark.uk down: ONE call on the last balance known, then busy until it answers; BlackArk's alert once", async () => {
    const t = await billed({ balance: 10_000 });
    await deskWithBalance(t);
    t.bank.reachable = false;
    expect(await t.voice(billedLine, 30)).toContain("<Connect>");
    expect(await t.voice(billedLine, 31)).toContain('<Reject reason="busy"/>');
    expect(await t.voice(billedLine, 32)).toContain('<Reject reason="busy"/>');
    const alerts = async () =>
      ((await (await t.admin("alerts", {})).json()) as { alerts: unknown[] })
        .alerts;
    expect(await alerts()).toMatchObject([
      {
        subject: "ArkAgent phone relay: blackark.uk is not answering",
        outcome: "recorded only (no mailbox set up)",
      },
    ]);
    t.bank.reachable = true;
    expect(await t.voice(billedLine, 33)).toContain("<Connect>");
    // A new outage within the hour: the one call again, but no second alert.
    t.bank.reachable = false;
    expect(await t.voice(billedLine, 34)).toContain("<Connect>");
    expect(await t.voice(billedLine, 35)).toContain('<Reject reason="busy"/>');
    expect((await alerts()).length).toBe(1);
  });

  test("the alert email goes over a Workers TCP socket, TLS from the first byte, port 465", async () => {
    const mail = mailServer();
    const t = await billed({
      balance: 10_000,
      alerts: true,
      connect: mail.connect,
    });
    await deskWithBalance(t);
    t.bank.reachable = false;
    await t.voice(billedLine, 39);
    expect(mail.opened).toEqual([
      { hostname: "mail.example", port: 465, tls: "on" },
    ]);
    expect(mail.said).toContain("MAIL FROM:<alerts@blackark.example>");
    expect(mail.said).toContain("RCPT TO:<ops@blackark.example>");
    expect(mail.said.join("\n")).not.toContain("+3069");
    const { alerts } = (await (await t.admin("alerts", {})).json()) as {
      alerts: { outcome: string }[];
    };
    expect(alerts[0]?.outcome).toBe("sent");
  });

  test("blackark.uk down and no balance ever known: busy", async () => {
    const t = await billed({ balance: 10_000, reachable: false });
    expect(await t.voice(billedLine, 36)).toContain('<Reject reason="busy"/>');
  });

  test("a charge blackark.uk did not take is held against the balance and sent again by alarm", async () => {
    const t = await billed({
      balance: 200,
      timing: { minuteMs: 300, marginMs: 100, retryMs: 100 },
    });
    await deskWithBalance(t);
    await t.voice(billedLine, 37);
    t.bank.reachable = false;
    await t.status(billedLine, 37, "completed", 90);
    t.bank.reachable = true;
    // 200 less the unsent 2 minutes (156) cannot pay a new call's first minute.
    expect(await t.voice(billedLine, 38)).toContain('<Reject reason="busy"/>');
    t.asked.length = 0;
    await until(() => t.asked.some((m) => m.action === "charge"));
    expect(t.asked.find((m) => m.action === "charge")).toMatchObject({
      callId: callId(37),
      parts: [{ kind: "incoming", seconds: 90 }],
    });
    expect(t.bank.balance).toBe(200 - 156);
  });

  test("a second billed line for the same customer is refused (the balance cannot be spent twice)", async () => {
    const t = await billed();
    await t.admin("add", {
      line: { ...demoLine, tokenSha256: "0".repeat(64) },
    });
    const refused = await t.admin("bill", {
      name: "demo-shop",
      customerId: "demo-phone",
    });
    expect(refused.status).toBe(409);
  });
});

describe("the admin door", () => {
  test("is closed without the admin token", async () => {
    const t = fresh({ billing: false });
    expect((await t.admin("add", { line: demoLine }, "wrong")).status).toBe(
      404,
    );
    expect((await t.admin("lines", {}, "wrong")).status).toBe(404);
  });

  test("a removed line's install is let go and cannot connect again", async () => {
    const t = fresh({ billing: false });
    await t.admin("add", { line: demoLine });
    const desk = await t.connectedDesk();
    await t.admin("remove", { name: "demo-shop" });
    await until(() => desk.readyState === 3);
    expect(((await t.desk()) as Response).status).toBe(401);
  });
});

export type { FakeSocket };
