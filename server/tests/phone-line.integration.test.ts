/**
 * The business's phone line (#109) end to end on this machine: the real relay from
 * `infra/phone-relay`, a fake Twilio in front of it, this install's phone line behind it, and a fake
 * speech service. Nothing dials Twilio or OpenAI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createRelay,
  sha256Hex,
  twilioSignature,
} from "../../infra/phone-relay/relay";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { type AuditEventInput, recordAuditEvent } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  phoneCalls,
  phoneLine,
  users,
} from "../src/db/schema";
import {
  phoneRules,
  type SpeechSocket,
  startCallBridge,
} from "../src/phone-line/bridge";
import {
  createPhoneLineService,
  isOpen,
  lineSocketUrl,
} from "../src/phone-line/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const userId = `phone-line-${randomUUID()}`;
let agentId = "";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = "relay-test-auth-token";
const callId = `CA${"b".repeat(32)}`;
const lineToken = "line-token-for-the-phone-line-test";
const events: AuditEventInput[] = [];

/** A speech service that records what it is sent and lets the test speak for it. */
function fakeSpeech() {
  const sockets: (SpeechSocket & {
    sent: Record<string, unknown>[];
    emit: (event: Record<string, unknown>) => void;
  })[] = [];
  const connect = () => {
    const socket = {
      sent: [] as Record<string, unknown>[],
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      send(data: string) {
        socket.sent.push(JSON.parse(data));
      },
      close() {
        socket.onclose?.();
      },
      emit(event: Record<string, unknown>) {
        socket.onmessage?.({ data: JSON.stringify(event) });
      },
    };
    sockets.push(socket);
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
  return { sockets, connect };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(15);
  }
  expect(await check()).toBe(true);
};

const redirects: string[] = [];
let base = "";
const relay = createRelay({
  accountSid,
  authToken,
  get publicBaseUrl() {
    return base;
  },
  lines: () => [
    {
      name: "test",
      number: "+302100000000",
      tokenSha256: sha256Hex(lineToken),
      fallback: "+306900000001",
    },
  ],
  fetch: (async (_url: string, init: RequestInit) => {
    redirects.push(decodeURIComponent(String(init.body)));
    return new Response("{}");
  }) as typeof fetch,
  log: () => undefined,
});
const relayServer = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
base = `http://localhost:${relayServer.port}`;

const speech = fakeSpeech();
/** The paid add-on (MD, 15 Nov): off until the test switches it on. */
let phoneOrdered = false;
const service = createPhoneLineService(database, {
  credentials: createCredentialStore(database),
  encryptionKey,
  auditStore: { insert: async (event) => void events.push(event) },
  employee: async (owner, id) =>
    owner === userId && id === agentId
      ? {
          name: "Υποδοχή",
          title: "Front Desk",
          instruction: "Never give medical advice.",
        }
      : null,
  business: async () => "Eurodiagnosi",
  blockAmka: async () => true,
  allowed: async () => phoneOrdered,
  connectSpeech: speech.connect,
  allowInsecureRelay: true,
});

afterAll(async () => {
  await service.stop();
  void relayServer.stop(true);
  await database.delete(phoneCalls).where(eq(phoneCalls.callId, callId));
  await database.delete(phoneLine);
  if (agentId) {
    await database
      .delete(agentPreferences)
      .where(eq(agentPreferences.agentId, agentId));
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

describe("the phone line (#109)", () => {
  test("opening hours are read in Athens time, and no hours means always open", () => {
    // Sunday 15 Nov 2026, 11:30 Athens (09:30 UTC).
    const sundayMorning = new Date("2026-11-15T09:30:00Z");
    expect(isOpen(null, sundayMorning)).toBe(true);
    expect(isOpen({ "0": { from: "09:00", to: "13:00" } }, sundayMorning)).toBe(
      true,
    );
    expect(isOpen({ "1": { from: "09:00", to: "17:00" } }, sundayMorning)).toBe(
      false,
    );
    expect(isOpen({ "0": { from: "12:00", to: "13:00" } }, sundayMorning)).toBe(
      false,
    );
  });

  test("the relay address must be https, with nothing hidden in it", () => {
    expect(lineSocketUrl("https://phone.blackark.uk")).toBe(
      "wss://phone.blackark.uk/line",
    );
    expect(lineSocketUrl("http://phone.blackark.uk")).toBeNull();
    expect(lineSocketUrl("https://user:pw@phone.blackark.uk")).toBeNull();
    expect(lineSocketUrl("https://phone.blackark.uk/?x=1")).toBeNull();
  });

  test("the rules say what the employee may never do", () => {
    const rules = phoneRules({
      business: "Eurodiagnosi",
      employee: "Υποδοχή",
      title: "Front Desk",
      afterHours: true,
      blockAmka: true,
    });
    expect(rules).toContain("Never call yourself an AI");
    expect(rules).toContain("digital employee");
    expect(rules).toContain("no outgoing calls");
    expect(rules).toContain("closed now");
    expect(rules).toContain("AMKA");
  });

  test("a callback with an AMKA-shaped number is refused, and after hours nobody is put through", () => {
    const sent: Record<string, unknown>[] = [];
    const local = fakeSpeech();
    let ended: unknown = null;
    const bridge = startCallBridge({
      callId: "CA1",
      from: "+306912345678",
      model: "gpt-realtime",
      apiKey: "k",
      voice: "marin",
      instructions: "x",
      greeting: "Καλημέρα",
      blockAmka: true,
      afterHours: true,
      relay: (message) => sent.push(message),
      connect: local.connect,
      onEnd: (record) => {
        ended = record;
      },
    });
    const socket = local.sockets[0];
    if (!socket) throw new Error("no speech socket");
    socket.onopen?.();
    socket.emit({
      type: "response.function_call_arguments.done",
      name: "take_callback",
      call_id: "t1",
      arguments: JSON.stringify({ name: "Anna", reason: "AMKA 01017012345" }),
    });
    socket.emit({
      type: "response.function_call_arguments.done",
      name: "hand_over",
      call_id: "t2",
      arguments: JSON.stringify({ reason: "wants a person" }),
    });
    const outputs = socket.sent
      .filter((event) => event.type === "conversation.item.create")
      .map((event) => JSON.stringify(event));
    expect(outputs[0]).toContain("AMKA");
    expect(outputs[1]).toContain("closed");
    expect(sent.some((message) => message.type === "transfer")).toBe(false);
    bridge.ended();
    expect(ended).toMatchObject({ outcome: "after_hours" });
  });

  test("a call goes through the relay to the employee and back, and lands in the call log", async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: "Admin" });
    const employee = await createAgentProfileStore(database, undefined).create(
      { id: userId, role: "admin" },
      {
        name: "Υποδοχή",
        title: "Front Desk",
        roleDescription: "Answers the phone.",
        visibility: "private",
        systemPrompt: "Never give medical advice.",
      },
    );
    agentId = employee.id;

    const line = {
      relayUrl: base,
      lineToken,
      speechKey: "sk-test-speech-key",
      agentId,
      speechModel: "gpt-realtime",
      voice: "marin",
      greeting: "Eurodiagnosi, καλημέρα σας.",
      hours: null,
      enabled: true,
    };

    // Without the paid add-on: nothing is saved, and nothing connects to the relay.
    service.start();
    await expect(service.save(userId, line)).rejects.toThrow("paid add-on");
    expect(await service.settings()).toBeNull();
    await Bun.sleep(100);
    expect(relay.state.desks.size).toBe(0);

    phoneOrdered = true;
    const saved = await service.save(userId, {
      relayUrl: base,
      lineToken,
      speechKey: "sk-test-speech-key",
      agentId,
      speechModel: "gpt-realtime",
      voice: "marin",
      greeting: "Eurodiagnosi, καλημέρα σας.",
      hours: null,
      enabled: true,
    });
    expect(JSON.stringify(saved)).not.toContain(lineToken);
    expect(JSON.stringify(saved)).not.toContain("sk-test-speech-key");
    await until(async () => (await service.settings())?.status === "connected");

    // Twilio rings the relay.
    const params = {
      AccountSid: accountSid,
      CallSid: callId,
      From: "+306912345678",
      To: "+302100000000",
    };
    const twiml = await (
      await fetch(`${base}/twilio/voice`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilioSignature(
            authToken,
            `${base}/twilio/voice`,
            params,
          ),
        },
        body: new URLSearchParams(params).toString(),
      })
    ).text();
    const key = /name="key" value="([^"]+)"/.exec(twiml)?.[1] ?? "";
    expect(key).not.toBe("");

    const twilio = new WebSocket(
      `ws://localhost:${relayServer.port}/twilio/media`,
    );
    const heard: Record<string, unknown>[] = [];
    twilio.onmessage = (event) => heard.push(JSON.parse(String(event.data)));
    await new Promise((resolve) => {
      twilio.onopen = resolve;
    });
    twilio.send(
      JSON.stringify({
        event: "start",
        start: { callSid: callId, streamSid: "MZ9", customParameters: { key } },
      }),
    );

    // The employee's speech session opens with the phone format, the rules and its instruction.
    await until(
      () => speech.sockets.length === 1 && speech.sockets[0]!.sent.length >= 2,
    );
    const talk = speech.sockets[0]!;
    const session = talk.sent[0] as {
      type: string;
      session: Record<string, unknown>;
    };
    expect(session.type).toBe("session.update");
    expect(JSON.stringify(session.session)).toContain("audio/pcmu");
    expect(String(session.session.instructions)).toContain(
      "Never call yourself an AI",
    );
    expect(String(session.session.instructions)).toContain(
      "Never give medical advice.",
    );
    expect(String(session.session.instructions)).toContain("Eurodiagnosi");

    // Caller audio reaches the speech service; the answer reaches the caller.
    twilio.send(
      JSON.stringify({ event: "media", media: { payload: "CALLER" } }),
    );
    await until(() =>
      talk.sent.some(
        (event) =>
          event.type === "input_audio_buffer.append" &&
          event.audio === "CALLER",
      ),
    );
    talk.emit({ type: "response.output_audio.delta", delta: "ANSWER" });
    await until(() => heard.some((event) => event.event === "media"));
    expect(heard.find((event) => event.event === "media")).toMatchObject({
      streamSid: "MZ9",
      media: { payload: "ANSWER" },
    });

    // The caller talks over the employee: the queued answer is cleared.
    talk.emit({ type: "input_audio_buffer.speech_started" });
    await until(() => heard.some((event) => event.event === "clear"));

    // A callback, then the end of the call.
    talk.emit({
      type: "response.function_call_arguments.done",
      name: "take_callback",
      call_id: "c1",
      arguments: JSON.stringify({
        name: "Anna",
        reason: "Wants to move her appointment.",
      }),
    });
    talk.emit({
      type: "response.function_call_arguments.done",
      name: "end_call",
      call_id: "c2",
      arguments: JSON.stringify({
        summary: "Anna asked to move her appointment; callback taken.",
      }),
    });
    await until(
      () => redirects.some((body) => body.includes("<Hangup/>")),
      5000,
    );

    await until(async () => (await service.calls())[0]?.outcome === "callback");
    const [call] = await service.calls();
    expect(call).toMatchObject({
      fromNumber: "+306912345678",
      outcome: "callback",
      summary: "Anna asked to move her appointment; callback taken.",
      callback: {
        name: "Anna",
        number: "+306912345678",
        reason: "Wants to move her appointment.",
        done: false,
      },
    });
    expect(await service.markCallbackDone(call!.id)).toBe(true);
    expect(await service.markCallbackDone(call!.id)).toBe(false);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "phone.line_saved",
        "phone.call_answered",
        "phone.call_ended",
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("sk-test-speech-key");
    twilio.close();
    void recordAuditEvent;
  }, 20_000);
});
