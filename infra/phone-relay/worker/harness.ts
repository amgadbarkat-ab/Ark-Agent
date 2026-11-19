/**
 * The Workers phone relay wired to stand-ins, for its tests: the Worker and both objects over the
 * stand-in runtime, a stand-in blackark.uk (checks the relay's HMAC and keeps the balance), a stand-in
 * Twilio REST API (records hand-overs and hang-ups), and the log. Test code only.
 */
import { createHmac } from "node:crypto";
import { type CallPart, costOf, type Line, sha256Hex } from "../relay";
import { DirectoryObject } from "./directory-object";
import { createWorker } from "./index";
import { LineObject } from "./line-object";
import {
  FakeNamespace,
  type FakeSocket,
  standInPlatform,
  upgradedSocket,
} from "./stand-ins";
import type { Connect, Env } from "./types";

export const accountSid = `AC${"1".repeat(32)}`;
export const authToken = "test-auth-token";
export const base = "https://blackark-phone.example.workers.dev";
export const billingUrl = "https://blackark.example/checkin/phone/";
export const secret = "relay-secret-for-tests-0123456789abcdef";
export const adminToken = "admin-token-for-tests-0123456789";
export const rates = { incoming: 78, landline: 88, mobile: 139 };
export const callId = (n: number) => `CA${String(n).padStart(32, "0")}`;
export const caller = "+306912345678";

export const lineToken = "line-token-for-tests";
export const demoLine: Line = {
  name: "demo-shop",
  number: "+302101234567",
  tokenSha256: sha256Hex(lineToken),
  fallback: "+306900000000",
};

export async function hmacSha1(
  key: string,
  url: string,
  params: Record<string, string>,
) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((name) => name + params[name])
      .join("");
  return createHmac("sha1", key).update(data).digest("base64");
}

export const until = async (check: () => boolean, ms = 2000) => {
  for (let i = 0; i < ms / 5 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error("timed out waiting");
};

export function setup(
  options: {
    balance?: number;
    reachable?: boolean;
    billing?: boolean;
    timing?: {
      minuteMs?: number;
      marginMs?: number;
      refreshMs?: number;
      retryMs?: number;
    };
    connect?: Connect;
    alerts?: boolean;
    /** False: deployed before Twilio exists (no Account SID or Auth Token yet). */
    twilio?: boolean;
  } = {},
) {
  const logs: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const twilio: { url: string; body: string }[] = [];
  const bank = {
    balance: options.balance ?? 10_000,
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
  const fakeFetch = async (url: string, init: RequestInit = {}) => {
    if (url !== billingUrl) {
      twilio.push({ url, body: String(init.body) });
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
    if (request.action === "charge")
      bank.balance = Math.max(
        0,
        bank.balance - costOf(request.parts as CallPart[], rates),
      );
    return Response.json(view());
  };
  const platform = standInPlatform({
    fetch: fakeFetch,
    log: (line) => logs.push(line),
    connect: options.connect,
    timing: options.timing,
  });
  const env = {
    PUBLIC_BASE_URL: base,
    ...(options.twilio === false
      ? {}
      : { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken }),
    ADMIN_TOKEN: adminToken,
    ...(options.billing === false
      ? {}
      : { BILLING_URL: billingUrl, RELAY_SECRET: secret }),
    ...(options.alerts
      ? {
          ALERT_SMTP_HOST: "mail.example",
          ALERT_SMTP_PORT: "465",
          ALERT_SMTP_USER: "alerts@blackark.example",
          ALERT_FROM: "alerts@blackark.example",
          ALERT_TO: "ops@blackark.example",
          ALERT_SMTP_PASSWORD: "mailbox-password",
        }
      : {}),
  } as Env & { LINE: FakeNamespace; DIRECTORY: FakeNamespace };
  env.LINE = new FakeNamespace(
    (state) => new LineObject(state, env, platform),
  ) as never;
  env.DIRECTORY = new FakeNamespace(
    (state) => new DirectoryObject(state, env, platform),
  ) as never;
  const worker = createWorker(platform);

  const relay = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`${base}${path}`, init), env);
  const admin = (command: string, body: unknown, token = adminToken) =>
    relay(`/admin/${command}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  async function post(
    path: string,
    params: Record<string, string>,
    signature?: string,
  ) {
    return relay(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature":
          signature ?? (await hmacSha1(authToken, `${base}${path}`, params)),
      },
      body: new URLSearchParams(params).toString(),
    });
  }
  const voice = (line: Line, n: number) =>
    post("/twilio/voice", {
      AccountSid: accountSid,
      CallSid: callId(n),
      From: caller,
      To: line.number,
    }).then((response) => response.text());
  const status = (line: Line, n: number, callStatus: string, seconds: number) =>
    post("/twilio/status", {
      AccountSid: accountSid,
      CallSid: callId(n),
      CallStatus: callStatus,
      CallDuration: String(seconds),
      From: caller,
      To: line.number,
    });
  const dialed = (line: Line, n: number, seconds: number) =>
    post("/twilio/dialed", {
      AccountSid: accountSid,
      CallSid: callId(n),
      DialCallStatus: "completed",
      DialCallDuration: String(seconds),
      From: caller,
      To: line.number,
    });

  /** The install's `/line` socket, or the response when refused. */
  async function desk(token = lineToken): Promise<FakeSocket | Response> {
    const response = await relay("/line", {
      headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
    });
    return upgradedSocket(response) ?? response;
  }
  async function connectedDesk(token = lineToken): Promise<FakeSocket> {
    const socket = (await desk(token)) as FakeSocket;
    await until(() => socket.messages().some((m) => m.type === "hello"));
    return socket;
  }
  /** Twilio's media socket for the stream URL a `<Connect><Stream>` gave. */
  async function media(twiml: string): Promise<FakeSocket> {
    const url = /<Stream url="([^"]+)"/.exec(twiml)?.[1] ?? "";
    const path = new URL(url.replace(/^wss:/, "https:")).pathname;
    const response = await relay(path, { headers: { upgrade: "websocket" } });
    const socket = upgradedSocket(response);
    if (!socket) throw new Error(`no media socket: ${response.status}`);
    return socket;
  }
  /** Starts the stream Twilio would, with the parameters the TwiML gave. */
  function start(socket: FakeSocket, twiml: string, n: number, sid = "MZ1") {
    const customParameters: Record<string, string> = {};
    for (const [, name, value] of twiml.matchAll(
      /<Parameter name="([^"]+)" value="([^"]+)"\/>/g,
    ))
      customParameters[name as string] = value as string;
    socket.send(JSON.stringify({ event: "connected" }));
    socket.send(
      JSON.stringify({
        event: "start",
        start: { callSid: callId(n), streamSid: sid, customParameters },
      }),
    );
  }
  const stop = () => {
    env.LINE.stopAll();
    env.DIRECTORY.stopAll();
  };

  return {
    env,
    worker,
    relay,
    admin,
    post,
    voice,
    status,
    dialed,
    desk,
    connectedDesk,
    media,
    start,
    logs,
    asked,
    twilio,
    bank,
    stop,
  };
}

/**
 * A stand-in for `connect()` from `cloudflare:sockets` with a mail server at the other end: it records
 * the address and TLS option asked for and every line the relay says, and answers as SMTP does.
 */
export function mailServer() {
  const said: string[] = [];
  const opened: { hostname: string; port: number; tls?: string }[] = [];
  const connect: Connect = (address, options) => {
    opened.push({ ...address, tls: options?.secureTransport });
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
        controller.enqueue(new TextEncoder().encode("220 ready\r\n"));
      },
    });
    let inData = false;
    let pending = "";
    const reply = (text: string) =>
      push.enqueue(new TextEncoder().encode(`${text}\r\n`));
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        pending += new TextDecoder().decode(chunk);
        let at = pending.indexOf("\r\n");
        while (at >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 2);
          said.push(line);
          if (inData) {
            if (line === ".") {
              inData = false;
              reply("250 queued");
            }
          } else if (line.startsWith("EHLO")) reply("250 AUTH LOGIN");
          else if (line === "AUTH LOGIN") reply("334 VXNlcm5hbWU6");
          else if (said.at(-2) === "AUTH LOGIN") reply("334 UGFzc3dvcmQ6");
          else if (said.at(-3) === "AUTH LOGIN") reply("235 ok");
          else if (line === "DATA") {
            inData = true;
            reply("354 go");
          } else if (line === "QUIT") reply("221 bye");
          else reply("250 ok");
          at = pending.indexOf("\r\n");
        }
      },
    });
    return {
      readable,
      writable,
      opened: Promise.resolve(),
      close: async () => {
        try {
          push.close();
        } catch {}
      },
    };
  };
  return { connect, said, opened };
}

/** Twilio's REST bodies, decoded, for reading the TwiML in them. */
export function decoded(body: string) {
  return decodeURIComponent(body.replace(/\+/g, " "));
}
