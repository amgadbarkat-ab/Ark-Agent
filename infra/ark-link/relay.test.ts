/**
 * The Ark Link relay on this machine: a scripted desktop on its socket, and `fetch` and `WebSocket`
 * acting as the phone. Nothing leaves the machine.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DATA_KIND,
  DESK_CLOSE,
  type DeskMessage,
  decodeData,
  decodeRelayMessage,
  encodeControl,
  encodeData,
  newDeviceToken,
  newInstallToken,
  type RelayMessage,
  tokenHash,
} from "../../shared/ark-link";
import { createLinkRelay, type DeviceRoute } from "./relay";

const installToken = newInstallToken();
const otherToken = newInstallToken();
const installs = [
  { id: "demo-shop", tokenSha256: await tokenHash(installToken) },
  { id: "other-shop", tokenSha256: await tokenHash(otherToken) },
];
const logs: string[] = [];
const saved: DeviceRoute[][] = [];
let clock = Date.now();

const relay = createLinkRelay({
  linkOrigin: "https://link.example",
  installs: () => installs,
  devices: { load: () => [], save: (routes) => saved.push(routes) },
  apps: {
    android: {
      appId: "blackark.arkagent",
      certFingerprints: [Array(32).fill("AB").join(":")],
    },
  },
  limits: {
    burst: 30,
    requestsPerMinute: 30,
    maxRequestBytes: 1024,
    maxStreamsPerDevice: 4,
    httpIdleMs: 300,
    headTimeoutMs: 1000,
    claimsPerMinute: 5,
  },
  trustProxy: true,
  log: (line) => logs.push(line),
  now: () => clock,
});
const server = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
const base = `http://localhost:${server.port}`;
const wsBase = `ws://localhost:${server.port}`;

afterAll(() => {
  relay.stop();
  void server.stop(true);
});

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await Bun.sleep(5);
  expect(check()).toBe(true);
};

type Handler = (
  message: Extract<RelayMessage, { t: "req" }>,
  desk: FakeDesk,
  body: Uint8Array[],
) => void;

/** A desktop speaking the protocol by hand. */
class FakeDesk {
  socket: WebSocket;
  received: RelayMessage[] = [];
  data: { kind: number; stream: number; payload: Uint8Array }[] = [];
  closed: { code: number } | null = null;
  ready: Promise<void>;
  handler: Handler = (req, desk) =>
    desk.reply(req.s, 200, "hello from the desk");
  bodies = new Map<number, Uint8Array[]>();

  constructor(token = installToken, version = "1") {
    this.socket = new WebSocket(`${wsBase}/_link/desk`, {
      headers: {
        authorization: `Bearer ${token}`,
        "ark-link-version": version,
      },
    } as never);
    this.socket.binaryType = "arraybuffer";
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("refused"));
    });
    this.socket.onclose = (event) => {
      this.closed = { code: event.code };
    };
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = decodeRelayMessage(event.data);
        if (!message) return;
        this.received.push(message);
        if (message.t === "req") {
          this.bodies.set(message.s, []);
          if (!message.body) this.handler(message, this, []);
          else this.pendingReq.set(message.s, message);
        }
        if (message.t === "end") {
          const req = this.pendingReq.get(message.s);
          if (req) this.handler(req, this, this.bodies.get(message.s) ?? []);
        }
        if (message.t === "ping") this.send({ t: "pong", at: message.at });
        return;
      }
      const frame = decodeData(event.data as ArrayBuffer);
      if (!frame) return;
      this.data.push({ ...frame, payload: frame.payload.slice() });
      if (frame.kind === DATA_KIND.body)
        this.bodies.get(frame.stream)?.push(frame.payload.slice());
    };
  }
  pendingReq = new Map<number, Extract<RelayMessage, { t: "req" }>>();
  send(message: DeskMessage) {
    this.socket.send(encodeControl(message));
  }
  reply(
    s: number,
    status: number,
    text: string,
    headers: [string, string][] = [],
  ) {
    this.send({
      t: "res",
      s,
      status,
      headers: [["content-type", "text/plain"], ...headers],
    });
    if (text)
      this.socket.send(
        encodeData(DATA_KIND.body, s, new TextEncoder().encode(text)),
      );
    this.send({ t: "end", s });
  }
  last<T extends RelayMessage["t"]>(t: T) {
    return this.received.findLast((m) => m.t === t) as
      | Extract<RelayMessage, { t: T }>
      | undefined;
  }
}

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Pairs a phone with `desk` the whole way, as a person would. Returns its device token. */
async function pair(
  desk: FakeDesk,
  deviceId = `dev${Math.random().toString(36).slice(2, 8)}`,
) {
  const startId = `start${++phones}`;
  desk.send({ t: "pair.start", id: startId });
  await until(() => desk.last("pair.started")?.id === startId);
  const started = desk.last("pair.started");
  const claim = await (
    await post(
      "/_link/pair/claim",
      { code: started?.code, deviceName: "Pixel 8" },
      { "x-forwarded-for": `10.0.0.${++phones}` },
    )
  ).json();
  expect(claim.status).toBe("pending");
  await until(() => desk.last("pair.claimed") !== undefined);
  const token = newDeviceToken();
  desk.send({
    t: "pair.confirm",
    pairingId: claim.pairingId,
    device: {
      id: deviceId,
      name: "Pixel 8",
      tokenSha256: await tokenHash(token),
    },
    token,
  });
  await Bun.sleep(30);
  const status = await post("/_link/pair/status", {
    pairingId: claim.pairingId,
  });
  const answer = await status.json();
  expect(answer).toEqual({
    status: "confirmed",
    deviceToken: token,
    deviceName: "Pixel 8",
  });
  expect(status.headers.get("set-cookie")).toContain(`ark_link=${token}`);
  expect(status.headers.get("set-cookie")).toContain("HttpOnly");
  return { token, deviceId };
}

let desk: FakeDesk;
let phones = 0;
beforeEach(async () => {
  if (!desk || desk.closed) {
    desk = new FakeDesk();
    await desk.ready;
    await until(() => desk.last("hello") !== undefined);
  }
  desk.handler = (req, d) => d.reply(req.s, 200, "hello from the desk");
});

describe("the desktop's socket", () => {
  test("the desktop is greeted with its install, the link's origin and the Android app it vouches for", () => {
    expect(desk.last("hello")).toEqual({
      t: "hello",
      v: 1,
      installId: "demo-shop",
      linkOrigin: "https://link.example",
      androidPackage: "blackark.arkagent",
    });
  });

  test("an unknown install token is refused before the socket opens", async () => {
    const stranger = new FakeDesk(newInstallToken());
    await expect(stranger.ready).rejects.toThrow();
    const response = await fetch(`${base}/_link/desk`, {
      headers: { authorization: "Bearer nonsense" },
    });
    expect(response.status).toBe(401);
  });

  test("a desktop speaking another protocol version is told so and closed", async () => {
    const future = new FakeDesk(otherToken, "2");
    await until(() => future.closed !== null);
    expect(future.closed?.code).toBe(DESK_CLOSE.version);
  });
});

describe("pairing", () => {
  test("a confirmed phone receives its token once, and the relay keeps only the hash", async () => {
    const { token, deviceId } = await pair(desk);
    const route = relay.routed.find((r) => r.id === deviceId);
    expect(route).toEqual({
      id: deviceId,
      installId: "demo-shop",
      tokenSha256: await tokenHash(token),
    });
    expect(JSON.stringify(saved.at(-1))).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
  });

  test("a code works once", async () => {
    desk.send({ t: "pair.start", id: "s2" });
    await until(() => desk.last("pair.started")?.id === "s2");
    const code = desk.last("pair.started")?.code;
    const first = await post("/_link/pair/claim", { code, deviceName: "A" });
    expect((await first.json()).status).toBe("pending");
    const again = await post("/_link/pair/claim", { code, deviceName: "B" });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({
      status: "refused",
      reason: "unknown",
    });
  });

  test("a code is refused after five minutes", async () => {
    desk.send({ t: "pair.start", id: "s3" });
    await until(() => desk.last("pair.started")?.id === "s3");
    const code = desk.last("pair.started")?.code;
    clock += 5 * 60_000 + 1;
    const late = await post("/_link/pair/claim", { code, deviceName: "Late" });
    expect(await late.json()).toEqual({ status: "refused", reason: "unknown" });
  });

  test("a pairing the person declines tells the phone so", async () => {
    desk.send({ t: "pair.start", id: "s4" });
    await until(() => desk.last("pair.started")?.id === "s4");
    const claim = await (
      await post("/_link/pair/claim", {
        code: desk.last("pair.started")?.code,
        deviceName: "Not mine",
      })
    ).json();
    expect(
      (
        await (
          await post("/_link/pair/status", { pairingId: claim.pairingId })
        ).json()
      ).status,
    ).toBe("pending");
    desk.send({ t: "pair.refuse", pairingId: claim.pairingId });
    await Bun.sleep(20);
    expect(
      await (
        await post("/_link/pair/status", { pairingId: claim.pairingId })
      ).json(),
    ).toEqual({
      status: "refused",
      reason: "refused",
    });
  });

  test("a desktop cannot confirm a pairing of another install", async () => {
    const other = new FakeDesk(otherToken);
    await other.ready;
    desk.send({ t: "pair.start", id: "s5" });
    await until(() => desk.last("pair.started")?.id === "s5");
    const claim = await (
      await post("/_link/pair/claim", {
        code: desk.last("pair.started")?.code,
        deviceName: "Victim",
      })
    ).json();
    const token = newDeviceToken();
    other.send({
      t: "pair.confirm",
      pairingId: claim.pairingId,
      device: {
        id: "intruder",
        name: "x",
        tokenSha256: await tokenHash(token),
      },
      token,
    });
    await Bun.sleep(30);
    expect(
      (
        await (
          await post("/_link/pair/status", { pairingId: claim.pairingId })
        ).json()
      ).status,
    ).toBe("pending");
    other.socket.close();
  });

  test("guessing codes is limited per address", async () => {
    const answers: number[] = [];
    for (let i = 0; i < 8; i++)
      answers.push(
        (
          await post(
            "/_link/pair/claim",
            { code: "AAAA-AAAA", deviceName: "x" },
            { "x-forwarded-for": "9.9.9.9" },
          )
        ).status,
      );
    expect(answers).toContain(429);
  });

  test("a write from another website is refused", async () => {
    const response = await post(
      "/_link/pair/claim",
      { code: "AAAAAAAA", deviceName: "x" },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  test("the pairing page is served in Greek and English under a strict policy", async () => {
    const response = await fetch(`${base}/_link/pair?code=ABCDEFGH`);
    const text = await response.text();
    expect(text).toContain("Σύνδεση");
    expect(text).toContain("Connect");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(text).not.toContain("<script>");
  });
});

describe("routing a phone's requests", () => {
  test("a paired phone reaches its desktop, without its device credential", async () => {
    const { token, deviceId } = await pair(desk);
    let seen: Extract<RelayMessage, { t: "req" }> | undefined;
    desk.handler = (req, d) => {
      seen = req;
      d.reply(req.s, 200, "hello from the desk", [
        ["set-cookie", "session=abc; Path=/"],
      ]);
    };
    const response = await fetch(`${base}/api/me?x=1`, {
      headers: {
        cookie: `ark_link=${token}; session=old`,
        "x-forwarded-host": "evil.example",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the desk");
    expect(response.headers.get("set-cookie")).toBe("session=abc; Path=/");
    expect(seen?.path).toBe("/api/me?x=1");
    expect(seen?.device).toEqual({ id: deviceId, token });
    const forwarded = Object.fromEntries(seen?.headers ?? []);
    expect(forwarded.cookie).toBe("session=old");
    expect(forwarded["x-forwarded-host"]).toBeUndefined();
  });

  test("the ArkLink header works as well as the cookie", async () => {
    const { token } = await pair(desk);
    const response = await fetch(`${base}/api/me`, {
      headers: { authorization: `ArkLink ${token}` },
    });
    expect(await response.text()).toBe("hello from the desk");
  });

  test("a request body reaches the desktop in frames", async () => {
    const { token } = await pair(desk);
    desk.handler = (req, d, body) => {
      const text = new TextDecoder().decode(Buffer.concat(body));
      d.reply(req.s, 201, `got ${text}`);
    };
    const response = await fetch(`${base}/api/things`, {
      method: "POST",
      headers: {
        authorization: `ArkLink ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('got {"a":1}');
  });

  test("an unsigned request is sent to pairing, or refused for a script", async () => {
    const page = await fetch(`${base}/`, {
      redirect: "manual",
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/_link/pair");
    const api = await fetch(`${base}/api/me`);
    expect(api.status).toBe(401);
    expect((await api.json()).code).toBe("ark_link_not_paired");
  });

  test("a wrong token is refused and its cookie cleared, without reaching any desktop", async () => {
    const before = desk.received.filter((m) => m.t === "req").length;
    const response = await fetch(`${base}/`, {
      headers: {
        cookie: `ark_link=${newDeviceToken()}`,
        "sec-fetch-mode": "navigate",
      },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.text()).toContain("δεν είναι συνδεδεμένο");
    expect(desk.received.filter((m) => m.t === "req").length).toBe(before);
  });

  test("a device the desktop removed is cut at once, its open socket too", async () => {
    const keep = await pair(desk, "keep1");
    const gone = await pair(desk, "gone1");
    desk.handler = (req, d) => {
      if (req.ws) d.send({ t: "ws.accept", s: req.s, protocol: "" });
      else d.reply(req.s, 200, "ok");
    };
    const socket = new WebSocket(`${wsBase}/api/channels/socket`, {
      headers: { cookie: `ark_link=${gone.token}` },
    } as never);
    let closedWith = 0;
    socket.onclose = (event) => {
      closedWith = event.code;
    };
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });
    desk.send({
      t: "devices",
      devices: [
        { id: keep.deviceId, tokenSha256: await tokenHash(keep.token) },
      ],
    });
    await until(() => closedWith !== 0);
    const refused = await fetch(`${base}/api/me`, {
      headers: { authorization: `ArkLink ${gone.token}` },
    });
    expect(refused.status).toBe(401);
    const kept = await fetch(`${base}/api/me`, {
      headers: { authorization: `ArkLink ${keep.token}` },
    });
    expect(kept.status).toBe(200);
  });

  test("a WebSocket passes through both ways", async () => {
    const { token } = await pair(desk);
    desk.handler = (req, d) => {
      if (!req.ws) return d.reply(req.s, 200, "");
      d.send({ t: "ws.accept", s: req.s, protocol: req.ws.protocols[0] ?? "" });
    };
    const socket = new WebSocket(`${wsBase}/api/channels/socket`, {
      headers: { authorization: `ArkLink ${token}` },
      protocols: ["ark.v1"],
    } as never);
    const heard: string[] = [];
    socket.onmessage = (event) => heard.push(String(event.data));
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });
    expect(socket.protocol).toBe("ark.v1");
    socket.send("from the phone");
    await until(() =>
      desk.data.some(
        (f) =>
          f.kind === DATA_KIND.wsText &&
          new TextDecoder().decode(f.payload) === "from the phone",
      ),
    );
    const s = desk.last("req")?.s as number;
    desk.socket.send(
      encodeData(
        DATA_KIND.wsText,
        s,
        new TextEncoder().encode("from the desk"),
      ),
    );
    await until(() => heard.includes("from the desk"));
    socket.close(1000, "bye");
    await until(() =>
      desk.received.some((m) => m.t === "ws.close" && m.s === s),
    );
  });

  test("when the desktop is off, the phone sees a clear page in Greek and English", async () => {
    const { token } = await pair(desk);
    desk.socket.close();
    await until(() => !relay.connected.includes("demo-shop"));
    const page = await fetch(`${base}/`, {
      headers: { cookie: `ark_link=${token}`, accept: "text/html" },
    });
    expect(page.status).toBe(503);
    const text = await page.text();
    expect(text).toContain("Ο υπολογιστής σας δεν είναι συνδεδεμένος");
    expect(text).toContain("Your computer is not connected");
    const api = await fetch(`${base}/api/me`, {
      headers: { authorization: `ArkLink ${token}` },
    });
    expect(api.status).toBe(503);
    expect((await api.json()).code).toBe("ark_link_offline");
  });

  test("a desktop that drops mid-request gives the phone the offline answer", async () => {
    desk = new FakeDesk();
    await desk.ready;
    const { token } = await pair(desk);
    desk.handler = (_req, d) => {
      d.socket.close();
    };
    const response = await fetch(`${base}/api/slow`, {
      headers: { authorization: `ArkLink ${token}` },
    });
    expect(response.status).toBe(503);
  });
});

describe("limits", () => {
  test("a body over the cap is refused", async () => {
    desk = new FakeDesk();
    await desk.ready;
    const { token } = await pair(desk);
    const response = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { authorization: `ArkLink ${token}` },
      body: "x".repeat(2048),
    });
    expect(response.status).toBe(413);
  });

  test("a device is held to its own rate", async () => {
    const { token } = await pair(desk);
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () =>
        fetch(`${base}/api/me`, {
          headers: { authorization: `ArkLink ${token}` },
        }).then((r) => r.status),
      ),
    );
    expect(statuses).toContain(429);
    expect(statuses).toContain(200);
  });

  test("a desktop that never answers is timed out, and a silent stream is ended", async () => {
    const { token } = await pair(desk);
    desk.handler = () => undefined;
    const response = await fetch(`${base}/api/never`, {
      headers: { authorization: `ArkLink ${token}` },
    });
    expect(response.status).toBe(504);
    await until(() => desk.received.some((m) => m.t === "cancel"));
  });

  test("no body, path or token is written to the log", () => {
    const text = logs.join("\n");
    expect(text).not.toContain("/api/");
    expect(text).not.toContain("arkd_");
    expect(text).not.toContain("hello from the desk");
  });
});

describe("the store apps", () => {
  test("assetlinks.json names the Android app, served by the relay", async () => {
    const response = await fetch(`${base}/.well-known/assetlinks.json`);
    const body = await response.json();
    expect(body[0].target.package_name).toBe("blackark.arkagent");
    expect(body[0].relation).toEqual([
      "delegate_permission/common.handle_all_urls",
    ]);
    const ios = await fetch(`${base}/.well-known/apple-app-site-association`);
    expect(ios.status).toBe(404);
  });
});
