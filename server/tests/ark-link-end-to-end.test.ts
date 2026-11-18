/**
 * Ark Link end to end on this machine (#149): the real relay from `infra/ark-link`, a stand-in
 * desktop (this install's real connector in front of a small local server playing the app), and
 * `fetch` and `WebSocket` acting as the phone. Nothing leaves the machine.
 *
 * Run alone with: bun test server/tests/ark-link-end-to-end.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createLinkRelay } from "../../infra/ark-link/relay";
import {
  newDeviceToken,
  newInstallToken,
  tokenHash,
} from "../../shared/ark-link";
import {
  type ArkLinkEvent,
  createArkLinkConnector,
  deskSocketUrl,
} from "../src/ark-link/connector";
import { cameThroughArkLink } from "../src/ark-link/marker";

const installToken = newInstallToken();
const relay = createLinkRelay({
  linkOrigin: "https://link.example",
  installs: () => [{ id: "demo-shop", tokenSha256: installHash }],
  log: () => undefined,
});
const installHash = await tokenHash(installToken);
const relayServer = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
const relayBase = `http://localhost:${relayServer.port}`;

/** The desktop's own server, as far as the phone can tell: what it was asked, and a socket. */
const seen: Request[] = [];
const app = Bun.serve<{ path: string }>({
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket")
      return server.upgrade(request, { data: { path: url.pathname } })
        ? undefined
        : new Response("no", { status: 400 });
    seen.push(request.clone());
    if (url.pathname === "/stream")
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const part of ["one ", "two ", "three"]) {
              controller.enqueue(new TextEncoder().encode(part));
              await Bun.sleep(20);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (url.pathname === "/gzip")
      return new Response(Bun.gzipSync("compressed answer"), {
        headers: { "content-encoding": "gzip", "content-type": "text/plain" },
      });
    if (url.pathname === "/echo")
      return new Response(`${request.method} ${await request.text()}`, {
        headers: [
          ["set-cookie", "a=1; Path=/"],
          ["set-cookie", "b=2; Path=/"],
        ],
      });
    if (url.pathname === "/marker")
      return new Response(String(cameThroughArkLink(request.headers)));
    if (url.pathname === "/redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "/elsewhere" },
      });
    return new Response(`the desktop's app at ${url.pathname}`);
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo ${message}`);
    },
  },
});

/** The desktop's own list of paired devices (the service keeps it in the database). */
const paired = new Map<string, string>();
const used: string[] = [];
const events: ArkLinkEvent[] = [];
const connector = createArkLinkConnector({
  relayUrl: relayBase,
  installToken,
  localOrigin: `http://127.0.0.1:${app.port}`,
  allowInsecureRelay: true,
  devices: {
    verify: async (id, hash) => paired.get(id) === hash,
    list: async () =>
      [...paired].map(([id, tokenSha256]) => ({ id, tokenSha256 })),
    used: (id) => used.push(id),
  },
  onEvent: (event) => events.push(event),
});

afterAll(() => {
  connector.stop();
  relay.stop();
  void relayServer.stop(true);
  void app.stop(true);
});

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await Bun.sleep(10);
  expect(check()).toBe(true);
};

const post = (path: string, body: unknown) =>
  fetch(`${relayBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The whole pairing, as the desktop's Settings → Phones and the phone's pairing page do it. */
async function pairPhone(name: string) {
  const { code } = await connector.startPairing();
  const claim = await (
    await post("/_link/pair/claim", { code, deviceName: name })
  ).json();
  expect(claim.status).toBe("pending");
  await until(() =>
    events.some((e) => e.type === "claimed" && e.pairingId === claim.pairingId),
  );
  // A person at the desktop confirmed the name.
  const token = newDeviceToken();
  const id = `dev-${paired.size + 1}`;
  const hash = await tokenHash(token);
  paired.set(id, hash);
  connector.confirm(claim.pairingId, { id, name, tokenSha256: hash }, token);
  await connector.syncDevices();
  let answer: { status: string; deviceToken?: string } = { status: "pending" };
  for (let i = 0; i < 50 && answer.status === "pending"; i++) {
    await Bun.sleep(10);
    answer = await (
      await post("/_link/pair/status", { pairingId: claim.pairingId })
    ).json();
  }
  expect(answer.status).toBe("confirmed");
  return { id, token: answer.deviceToken as string };
}

describe("Ark Link, relay to desktop to phone", () => {
  test("the connector is off until started, then connects out", async () => {
    expect(connector.status).toBe("off");
    expect(relay.connected).toEqual([]);
    connector.start();
    await until(() => connector.status === "connected");
    expect(relay.connected).toEqual(["demo-shop"]);
  });

  test("only an https relay address is used outside tests", () => {
    expect(deskSocketUrl("https://link.example")).toBe(
      "wss://link.example/_link/desk",
    );
    expect(deskSocketUrl("http://link.example")).toBeNull();
    expect(deskSocketUrl("https://link.example/path")).toBeNull();
    expect(deskSocketUrl("https://user:pw@link.example")).toBeNull();
  });

  test("a paired phone gets the desktop's own app, told it came through the link", async () => {
    const phone = await pairPhone("Pixel 8");
    const page = await fetch(`${relayBase}/settings?tab=1`, {
      headers: {
        cookie: `ark_link=${phone.token}`,
        origin: "https://link.example",
      },
    });
    expect(await page.text()).toBe("the desktop's app at /settings");
    const request = seen.at(-1) as Request;
    expect(new URL(request.url).search).toBe("?tab=1");
    expect(request.headers.get("x-forwarded-host")).toBe(
      `localhost:${relayServer.port}`,
    );
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
    expect(used).toContain(phone.id);
  });

  test("bodies, repeated cookies, redirects and compressed answers come through unchanged", async () => {
    const phone = await pairPhone("iPhone");
    const auth = { authorization: `ArkLink ${phone.token}` };
    const echo = await fetch(`${relayBase}/echo`, {
      method: "PUT",
      headers: auth,
      body: "x".repeat(200_000),
    });
    expect(await echo.text()).toBe(`PUT ${"x".repeat(200_000)}`);
    expect(echo.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const redirect = await fetch(`${relayBase}/redirect`, {
      headers: auth,
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/elsewhere");
    const gzip = await fetch(`${relayBase}/gzip`, { headers: auth });
    expect(await gzip.text()).toBe("compressed answer");
  });

  test("a streamed answer arrives as it is written", async () => {
    const phone = await pairPhone("Tablet");
    const response = await fetch(`${relayBase}/stream`, {
      headers: { authorization: `ArkLink ${phone.token}` },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("one two three");
  });

  test("the desktop's server can tell a phone's request from its own, whatever the phone sends", async () => {
    const phone = await pairPhone("Marked phone");
    const throughLink = await fetch(`${relayBase}/marker`, {
      headers: {
        authorization: `ArkLink ${phone.token}`,
        "x-ark-link-proof": "made-up",
      },
    });
    expect(await throughLink.text()).toBe("true");
    const onTheComputer = await fetch(`http://127.0.0.1:${app.port}/marker`, {
      headers: { "x-ark-link-proof": "made-up" },
    });
    expect(await onTheComputer.text()).toBe("false");
  });

  test("a WebSocket reaches the desktop's server and back", async () => {
    const phone = await pairPhone("Socket phone");
    const socket = new WebSocket(
      `ws://localhost:${relayServer.port}/api/channels/socket`,
      { headers: { cookie: `ark_link=${phone.token}` } } as never,
    );
    const heard: string[] = [];
    socket.onmessage = (event) => heard.push(String(event.data));
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });
    socket.send("hello");
    await until(() => heard.includes("echo hello"));
    socket.close();
  });

  test("a device removed on the desktop is refused there, even before the relay hears", async () => {
    const phone = await pairPhone("Lost phone");
    paired.delete(phone.id);
    // The relay still routes it (no sync yet); the desktop's own check refuses it.
    const refused = await fetch(`${relayBase}/api/me`, {
      headers: { authorization: `ArkLink ${phone.token}` },
    });
    expect(refused.status).toBe(401);
    // And the connector told the relay, so the next request does not even reach the desktop.
    await until(() => !relay.routed.some((r) => r.id === phone.id));
  });

  test("when the desktop stops, the phone gets the offline page; when it returns, the app", async () => {
    const phone = await pairPhone("Patient phone");
    connector.stop();
    await until(() => relay.connected.length === 0);
    const offline = await fetch(`${relayBase}/`, {
      headers: { cookie: `ark_link=${phone.token}`, accept: "text/html" },
    });
    expect(offline.status).toBe(503);
    expect(await offline.text()).toContain("Your computer is not connected");
    connector.start();
    await until(() => connector.status === "connected");
    const back = await fetch(`${relayBase}/`, {
      headers: { cookie: `ark_link=${phone.token}` },
    });
    expect(await back.text()).toBe("the desktop's app at /");
  });

  test("a wrong install token never connects", async () => {
    const stranger = createArkLinkConnector({
      relayUrl: relayBase,
      installToken: newInstallToken(),
      localOrigin: `http://127.0.0.1:${app.port}`,
      allowInsecureRelay: true,
      devices: {
        verify: async () => true,
        list: async () => [],
        used: () => undefined,
      },
    });
    stranger.start();
    await Bun.sleep(200);
    expect(stranger.status).toBe("connecting");
    expect(stranger.problem).toContain("refused this install token");
    expect(relay.connected).toEqual(["demo-shop"]);
    stranger.stop();
  });
});
