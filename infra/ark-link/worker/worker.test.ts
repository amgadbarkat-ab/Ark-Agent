/**
 * The Workers relay (#149) under `bun test`, against stand-ins for the runtime (`stand-ins.ts`): the
 * desktop is this install's real connector, the desktop's app a small local server, and the phone is
 * `fetch`-shaped requests and socket ends. Covers pairing, routing, bodies streamed through, a
 * WebSocket passing through, removal, the desktop offline, waking from hibernation with a phone socket
 * still open, and the heartbeat answered without waking anything.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  type ArkLinkEvent,
  createArkLinkConnector,
} from "../../../server/src/ark-link/connector";
import {
  newDeviceToken,
  newInstallToken,
  tokenHash,
} from "../../../shared/ark-link";
import { DirectoryObject } from "./directory-object";
import { createWorker } from "./index";
import { InstallObject } from "./install-object";
import {
  FakeNamespace,
  type FakeSocket,
  type StandInEnv,
  standInPlatform,
  upgradedSocket,
} from "./stand-ins";
import type { Env } from "./types";

const installToken = newInstallToken();
const env = {
  LINK_ORIGIN: "https://link.example",
  LINK_INSTALLS: JSON.stringify([
    { id: "demo-shop", tokenSha256: await tokenHash(installToken) },
  ]),
  ARK_ANDROID_APP_ID: "blackark.arkagent",
  ARK_ANDROID_CERT_SHA256: Array(32).fill("AB").join(":"),
} as StandInEnv;
env.INSTALL = new FakeNamespace(
  (state) => new InstallObject(state, env as Env, standInPlatform),
);
env.DIRECTORY = new FakeNamespace(
  (state) => new DirectoryObject(state, env as Env),
);
const worker = createWorker();
const relay = (input: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://link.example${input}`, init), env as Env);

/** The desktop's app on this machine. */
const seen: Request[] = [];
const app = Bun.serve<{ path: string }>({
  port: 0,
  async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket")
      return server.upgrade(request, { data: { path: "" } })
        ? undefined
        : new Response("no", { status: 400 });
    seen.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/echo")
      return new Response(`${request.method} ${await request.text()}`);
    if (url.pathname === "/stream")
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const part of ["one ", "two ", "three"]) {
              controller.enqueue(new TextEncoder().encode(part));
              await Bun.sleep(10);
            }
            controller.close();
          },
        }),
      );
    return new Response(`the desktop's app at ${url.pathname}`);
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo ${message}`);
    },
  },
});

/** The connector's socket, over the relay's stand-in socket instead of a network one. */
function openThroughWorker(_url: string, headers: Record<string, string>) {
  let client: FakeSocket | undefined;
  const queued: (string | Uint8Array)[] = [];
  const socket = {
    readyState: 0,
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as ((event: { code: number; reason: string }) => void) | null,
    onerror: null as (() => void) | null,
    send(data: string | Uint8Array) {
      if (client) client.send(data);
      else queued.push(data);
    },
    close(code = 1000, reason = "") {
      socket.readyState = 3;
      client?.close(code, reason);
    },
  };
  void relay("/_link/desk", {
    headers: { ...headers, upgrade: "websocket" },
  }).then((response) => {
    client = upgradedSocket(response);
    if (!client) {
      socket.readyState = 3;
      socket.onclose?.({ code: 1006, reason: "" });
      return;
    }
    socket.readyState = 1;
    client.onmessage = (data) =>
      socket.onmessage?.({
        data:
          typeof data === "string"
            ? data
            : data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength,
              ),
      });
    client.onclose = (code, reason) => {
      socket.readyState = 3;
      socket.onclose?.({ code, reason });
    };
    // What arrived before the handler was set (the greeting), then what the connector queued.
    for (const data of client.received.splice(0)) client.onmessage(data);
    for (const data of queued.splice(0)) client.send(data);
  });
  return socket as unknown as WebSocket;
}

const paired = new Map<string, string>();
const events: ArkLinkEvent[] = [];
const connector = createArkLinkConnector({
  relayUrl: "https://link.example",
  installToken,
  localOrigin: `http://127.0.0.1:${app.port}`,
  devices: {
    verify: async (id, hash) => (paired.get(id) === hash ? "ok" : "refused"),
    list: async () =>
      [...paired].map(([id, tokenSha256]) => ({ id, tokenSha256 })),
    used: () => undefined,
  },
  onEvent: (event) => events.push(event),
  openSocket: openThroughWorker,
});

afterAll(() => {
  connector.stop();
  void app.stop(true);
});

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await Bun.sleep(5);
  expect(check()).toBe(true);
};

const post = (path: string, body: unknown) =>
  relay(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function pairPhone(name: string) {
  const { code } = await connector.startPairing();
  const claim = await (
    await post("/_link/pair/claim", { code, deviceName: name })
  ).json();
  expect(claim.status).toBe("pending");
  await until(() =>
    events.some((e) => e.type === "claimed" && e.pairingId === claim.pairingId),
  );
  const token = newDeviceToken();
  const id = `dev-${paired.size + 1}`;
  const hash = await tokenHash(token);
  paired.set(id, hash);
  connector.confirm(claim.pairingId, { id, name, tokenSha256: hash }, token);
  await connector.syncDevices();
  let answer: { status: string; deviceToken?: string } = { status: "pending" };
  for (let i = 0; i < 100 && answer.status === "pending"; i++) {
    await Bun.sleep(5);
    answer = await (
      await post("/_link/pair/status", { pairingId: claim.pairingId })
    ).json();
  }
  expect(answer.status).toBe("confirmed");
  return { id, token: answer.deviceToken as string };
}

describe("the Workers relay", () => {
  test("the desktop connects to its own install object and is greeted", async () => {
    connector.start();
    await until(() => connector.status === "connected");
    expect(connector.androidPackage).toBe("blackark.arkagent");
    expect(env.INSTALL.state("demo-shop").getWebSockets("desk")).toHaveLength(
      1,
    );
  });

  test("a wrong install token is refused at the edge", async () => {
    const response = await relay("/_link/desk", {
      headers: { authorization: `Bearer ${newInstallToken()}` },
    });
    expect(response.status).toBe(401);
  });

  test("the relay's own paths are answered without any object", async () => {
    expect(await (await relay("/_link/health")).text()).toBe("ok");
    const links = await (await relay("/.well-known/assetlinks.json")).json();
    expect(links[0].target.package_name).toBe("blackark.arkagent");
    const page = await relay("/", {
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/_link/pair");
  });

  test("a phone pairs, and its requests reach the desktop with bodies streamed both ways", async () => {
    const phone = await pairPhone("Pixel");
    const auth = { authorization: `ArkLink ${phone.token}` };
    expect(await (await relay("/settings", { headers: auth })).text()).toBe(
      "the desktop's app at /settings",
    );
    const echo = await relay("/echo", {
      method: "PUT",
      headers: auth,
      body: "x".repeat(150_000),
    });
    expect(await echo.text()).toBe(`PUT ${"x".repeat(150_000)}`);
    expect(await (await relay("/stream", { headers: auth })).text()).toBe(
      "one two three",
    );
    // Nothing of the Worker's own reaches the desktop.
    const request = seen.at(-1) as Request;
    expect(request.headers.get("x-link-token")).toBeNull();
    expect(request.headers.get("x-link-route")).toBeNull();
  });

  test("a phone cannot use the install object's own door", async () => {
    const phone = await pairPhone("Curious phone");
    const sent = env.INSTALL.state("demo-shop").messages;
    const response = await relay("/_internal/send", {
      method: "POST",
      headers: { authorization: `ArkLink ${phone.token}` },
      body: JSON.stringify({ message: { t: "pair.started" } }),
    });
    // It is the desktop's app that answers, as for any path.
    expect(await response.text()).toBe("the desktop's app at /_internal/send");
    expect(env.INSTALL.state("demo-shop").messages).toBeGreaterThan(sent);
  });

  test("a WebSocket passes through, and survives the object being evicted (hibernation)", async () => {
    const phone = await pairPhone("Socket phone");
    const response = await relay("/api/channels/socket", {
      headers: {
        authorization: `ArkLink ${phone.token}`,
        upgrade: "websocket",
      },
    });
    const socket = upgradedSocket(response) as FakeSocket;
    expect(socket).toBeDefined();
    socket.send("hello");
    await until(() => socket.received.includes("echo hello"));
    env.INSTALL.evict("demo-shop");
    socket.send("again");
    await until(() => socket.received.includes("echo again"));
  });

  test("the desktop's heartbeat is answered by the runtime, without waking the object", async () => {
    const state = env.INSTALL.state("demo-shop");
    const before = state.messages;
    const desk = state.getWebSockets("desk")[0] as FakeSocket;
    desk.peer.send('{"t":"beat"}');
    await until(() => state.autoResponses > 0);
    expect(state.messages).toBe(before);
  });

  test("a device the desktop removed is refused at once", async () => {
    const phone = await pairPhone("Lost phone");
    paired.delete(phone.id);
    const refused = await relay("/api/me", {
      headers: { authorization: `ArkLink ${phone.token}` },
    });
    expect(refused.status).toBe(401);
  });

  test("a code works once", async () => {
    const { code } = await connector.startPairing();
    expect(
      (
        await (
          await post("/_link/pair/claim", { code, deviceName: "A" })
        ).json()
      ).status,
    ).toBe("pending");
    const again = await post("/_link/pair/claim", { code, deviceName: "B" });
    expect(again.status).toBe(404);
  });

  test("when the desktop goes, a paired phone gets the offline answer", async () => {
    const phone = await pairPhone("Patient phone");
    connector.stop();
    await until(
      () => env.INSTALL.state("demo-shop").getWebSockets("desk").length === 0,
    );
    const page = await relay("/", {
      headers: { authorization: `ArkLink ${phone.token}`, accept: "text/html" },
    });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Your computer is not connected");
    // And its codes can no longer be claimed.
    const claim = await post("/_link/pair/claim", {
      code: "ABCDEFGH",
      deviceName: "x",
    });
    expect([404, 503]).toContain(claim.status);
  });
});
