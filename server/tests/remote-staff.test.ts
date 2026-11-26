import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { startBunRelay } from "../../infra/staff-relay/bun-runtime";
import { makeOfficeCertificate } from "../src/office/certificate";
import {
  type JoinCode,
  parseJoinCode,
  encodeJoinCode,
} from "../src/office/join-code";
import { startJoinProxy } from "../src/office/join-proxy";
import { relayRefusal, startRemoteHost } from "../src/office/remote-host";

/**
 * Remote staff (v0.1.56): a staff computer away from the office reaches the company's ArkAgent
 * through BlackArk's staff relay, over the same TLS connection to the office listener, checked by
 * the same fingerprint. The relay here is the very Worker code that runs on Cloudflare, on Bun.
 */
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

const signing = generateKeyPairSync("ed25519");
const publicKey = Buffer.from(
  signing.publicKey.export({ format: "der", type: "spki" }).subarray(12),
).toString("base64");
function licenceKey(validUntil: string) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      action: "license",
      customer: "demo-shop",
      nonce: "n",
      issuedAt: new Date().toISOString(),
      plan: "ark-team",
      seats: 1,
      validUntil,
    }),
  ).toString("base64url");
  return `ARK1-${payload}.${sign(null, Buffer.from(payload), signing.privateKey).toString("base64url")}`;
}
const valid = licenceKey(new Date(Date.now() + 86_400_000).toISOString());

const until = async (check: () => boolean, ms = 5000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await Bun.sleep(10);
  if (!check()) throw new Error("timed out waiting");
};

/** The administrator's computer's office listener, as far as the staff computer can tell. */
function companyListener(
  cert = makeOfficeCertificate({ addresses: [], hostnames: [] }),
) {
  const seen: { path: string; host: string | null; origin: string | null }[] =
    [];
  const server = Bun.serve<{ cookie: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: cert.certificate, key: cert.key },
    async fetch(request, srv) {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname,
        host: request.headers.get("host"),
        origin: request.headers.get("origin"),
      });
      if (url.pathname === "/api/socket") {
        if (
          srv.upgrade(request, {
            data: { cookie: request.headers.get("cookie") },
          })
        )
          return undefined as unknown as Response;
      }
      if (url.pathname === "/api/auth/sign-in/email")
        return Response.json(
          { body: await request.text() },
          {
            headers: {
              "set-cookie": "better-auth.session_token=abc; Path=/; HttpOnly",
            },
          },
        );
      if (url.pathname === "/api/stream") {
        const body = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            await Bun.sleep(30);
            controller.enqueue(new TextEncoder().encode("data: two\n\n"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(`page ${url.pathname}`, {
        headers: { "content-type": "text/html" },
      });
    },
    websocket: {
      message(ws, message) {
        ws.send(`${ws.data.cookie} ${message}`);
      },
    },
  });
  stops.push(() => server.stop(true));
  return { server, seen, cert };
}

const office = "office-for-remote-staff-tests-01";
const hostKey = "host-key-for-remote-staff-tests-0123";
const accessKey = "access-key-for-remote-staff-tests-01";

function relay() {
  const started = startBunRelay({ keys: { license: [publicKey], trial: [] } });
  stops.push(started.stop);
  return started;
}

function host(
  url: string,
  listenerPort: number,
  licence: string | null = valid,
) {
  const started = startRemoteHost({
    relayUrl: url,
    office,
    hostKey,
    accessKey,
    licence: async () => licence,
    listenerPort: () => listenerPort,
  });
  stops.push(started.stop);
  return started;
}

async function staffComputer(code: JoinCode) {
  const started = await startJoinProxy({ code, port: 0 });
  stops.push(started.stop);
  return { ...started, local: `http://127.0.0.1:${started.port}` };
}

/** A join code whose office-network address does not answer here, so only the relay can be used. */
function awayCode(url: string, port: number, fingerprint: string): JoinCode {
  return {
    addresses: ["127.0.0.2"],
    port,
    fingerprint,
    relay: { url, office, key: accessKey },
  };
}

test("away from the office, pages, sign-in, live answers and sockets all go through the relay", async () => {
  const { server, seen, cert } = companyListener();
  const relayed = relay();
  const hosting = host(relayed.url, server.port as number);
  await until(() => hosting.status().connected);

  const code = awayCode(relayed.url, server.port as number, cert.fingerprint);
  const { local } = await staffComputer(code);
  expect(await (await fetch(`${local}/__ark_join/health`)).json()).toEqual({
    connected: true,
    via: "relay",
  });

  const signIn = await fetch(`${local}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: local, "content-type": "application/json" },
    body: JSON.stringify({ email: "nikos@shop.example" }),
  });
  expect(signIn.status).toBe(200);
  expect(signIn.headers.get("set-cookie")).toContain("session_token=abc");
  // The company's listener sees itself addressed on its own loopback, as its own page.
  expect(seen.at(-1)).toMatchObject({
    path: "/api/auth/sign-in/email",
    host: `127.0.0.1:${server.port}`,
    origin: `https://127.0.0.1:${server.port}`,
  });

  const streamed = await (await fetch(`${local}/api/stream`)).text();
  expect(streamed).toBe("data: one\n\ndata: two\n\n");

  const socket = new WebSocket(`${local.replace("http", "ws")}/api/socket`, {
    headers: { cookie: "better-auth.session_token=abc" },
  } as never);
  const answers: string[] = [];
  socket.onmessage = (event) => answers.push(String(event.data));
  await until(() => socket.readyState === WebSocket.OPEN);
  socket.send("hello");
  await until(() => answers.length === 1);
  expect(answers[0]).toBe("better-auth.session_token=abc hello");
  socket.close();
});

test("on the office network the relay is not used", async () => {
  const { server, cert } = companyListener();
  const relayed = relay();
  host(relayed.url, server.port as number);
  const code: JoinCode = {
    ...awayCode(relayed.url, server.port as number, cert.fingerprint),
    addresses: ["127.0.0.1"],
  };
  const { local } = await staffComputer(code);
  expect(await (await fetch(`${local}/__ark_join/health`)).json()).toEqual({
    connected: true,
    via: "office",
  });
});

test("a computer behind the relay with another certificate gets nothing from the staff computer", async () => {
  // The genuine company, whose fingerprint the join code carries...
  const genuine = makeOfficeCertificate({ addresses: [], hostnames: [] });
  // ...and an impostor that holds the office at the relay (say, the relay itself was compromised).
  const { server: impostor, seen } = companyListener();
  const relayed = relay();
  const hosting = host(relayed.url, impostor.port as number);
  await until(() => hosting.status().connected);

  const code = awayCode(
    relayed.url,
    impostor.port as number,
    genuine.fingerprint,
  );
  const { local } = await staffComputer(code);
  expect(
    (await (await fetch(`${local}/__ark_join/health`)).json()).connected,
  ).toBe(false);
  const signIn = await fetch(`${local}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: local, "content-type": "application/json" },
    body: JSON.stringify({ email: "nikos@shop.example", password: "secret" }),
  });
  expect(signIn.status).toBe(503);
  expect(seen).toHaveLength(0);
});

test("without a valid licence the relay refuses the company's computer, and says why", async () => {
  const { server } = companyListener();
  const relayed = relay();
  const expired = host(
    relayed.url,
    server.port as number,
    licenceKey(new Date(Date.now() - 1000).toISOString()),
  );
  await until(() => expired.status().error !== null);
  expect(expired.status()).toEqual({
    connected: false,
    error: relayRefusal(4401),
  });
});

test("without any licence the company's computer does not even try", async () => {
  const { server } = companyListener();
  const relayed = relay();
  const none = host(relayed.url, server.port as number, null);
  await until(() => none.status().error !== null);
  expect(none.status().connected).toBe(false);
  expect(none.status().error).toContain("licence key or trial activation code");
});

test("the join code carries the relay, and anything but a TLS relay address is refused", () => {
  const fingerprint = "a".repeat(64);
  const code = encodeJoinCode({
    addresses: [],
    port: 52443,
    fingerprint,
    relay: {
      url: "wss://blackark-staff.blackark.workers.dev",
      office,
      key: accessKey,
    },
  });
  expect(parseJoinCode(code)).toEqual({
    addresses: [],
    port: 52443,
    fingerprint,
    relay: {
      url: "wss://blackark-staff.blackark.workers.dev",
      office,
      key: accessKey,
    },
  });
  const insecure = encodeJoinCode({
    addresses: [],
    port: 52443,
    fingerprint,
    relay: { url: "ws://relay.example", office, key: accessKey },
  });
  expect(parseJoinCode(insecure)).toBeNull();
  const noWay = encodeJoinCode({ addresses: [], port: 52443, fingerprint });
  expect(parseJoinCode(noWay)).toBeNull();
});
