import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { makeOfficeCertificate } from "../src/office/certificate";
import { hubClientUrl } from "../src/office/hub-socket";
import { startJoinProxy } from "../src/office/join-proxy";
import { officeServeOptions } from "../src/office/listener";

/**
 * The whole way from a staff computer to the company's ArkAgent (Amgad, 24 Nov 2026, option A): the
 * staff computer's relay, the office listener on the administrator's computer, and behind it this
 * computer's own server and conversation hub, which answer on loopback only.
 */
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type Base = { kind: "base" };

function companyComputer() {
  // The conversation hub, on loopback: it echoes what it is sent, and the query it was joined with.
  const hub = Bun.serve<{ query: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (
        url.pathname === "/client" &&
        server.upgrade(request, { data: { query: url.search } })
      )
        return undefined as unknown as Response;
      return new Response("not here", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(`hub${ws.data.query} ${message}`);
      },
    },
  });
  stops.push(() => hub.stop(true));
  const hubWs = `ws://127.0.0.1:${hub.port}`;
  const cert = makeOfficeCertificate({ addresses: [], hostnames: [] });
  const seenOrigins: (string | null)[] = [];

  // The server's own request handling, as far as this path is concerned.
  const base = {
    fetch(request: Request, server: Server<Base>) {
      const url = new URL(request.url);
      if (url.pathname === "/api/office/certificate")
        return new Response(cert.certificate);
      if (url.pathname === "/api/copilotkit/info")
        return Response.json(
          { mode: "intelligence", intelligence: { wsUrl: `${hubWs}/client` } },
          {
            headers: {
              "content-security-policy": `default-src 'self'; connect-src 'self' ${hubWs}; object-src 'none'`,
            },
          },
        );
      if (url.pathname === "/api/channels/socket") {
        if (server.upgrade(request, { data: { kind: "base" } }))
          return undefined;
      }
      seenOrigins.push(request.headers.get("origin"));
      return Response.json({ origin: request.headers.get("origin") });
    },
    websocket: {
      message(ws: { send: (m: string) => void }, message: string | Buffer) {
        ws.send(`server ${message}`);
      },
    },
  };
  const office = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: cert.certificate, key: cert.key },
    ...officeServeOptions<Base>(base as never, {
      appOrigin: "http://localhost:52110",
      hub: hubClientUrl(hubWs),
    }),
  });
  stops.push(() => office.stop(true));
  return { office, cert, seenOrigins };
}

async function staffComputer(company: ReturnType<typeof companyComputer>) {
  const relay = await startJoinProxy({
    code: {
      addresses: ["127.0.0.1"],
      port: company.office.port as number,
      fingerprint: company.cert.fingerprint,
    },
    port: 0,
  });
  stops.push(relay.stop);
  return `http://127.0.0.1:${relay.port}`;
}

function talk(url: string, say: string): Promise<string> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.onopen = () => socket.send(say);
    socket.onmessage = (event) => {
      resolve(String(event.data));
      socket.close();
    };
    socket.onerror = () => reject(new Error(`socket to ${url} failed`));
    setTimeout(() => reject(new Error("timeout")), 4000);
  });
}

test("the chat's live connection reaches the hub through the staff computer, at its own address", async () => {
  const company = companyComputer();
  const local = await staffComputer(company);
  const info = await fetch(`${local}/api/copilotkit/info`);
  const wsUrl = (await info.json()).intelligence.wsUrl as string;
  // Not the hub's loopback on the company's computer, which this computer cannot reach.
  expect(wsUrl).toBe(`${local.replace("http", "ws")}/api/hub/client`);
  expect(info.headers.get("content-security-policy")).toContain(
    local.replace("http", "ws"),
  );
  // A join token as the hub signs it: the person in it may use ArkAgent, so the socket is carried.
  const token = `${Buffer.from(JSON.stringify({ s: { kind: "meta", userId: "u-1" }, exp: 9e9 })).toString("base64url")}.sig`;
  expect(await talk(`${wsUrl}?join_token=${token}`, "phx_join")).toBe(
    `hub?join_token=${token} phx_join`,
  );
});

test("the server's own sockets and requests pass too, as the app's own", async () => {
  const company = companyComputer();
  const local = await staffComputer(company);
  expect(
    await talk(`${local.replace("http", "ws")}/api/channels/socket`, "hello"),
  ).toBe("server hello");
  const signIn = await fetch(`${local}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: local, "content-type": "application/json" },
    body: "{}",
  });
  // Seen by the server as coming from the app itself, so sign-in accepts it.
  expect((await signIn.json()).origin).toBe("http://localhost:52110");
});

test("a page opened on the office address directly is told the office address for the hub", async () => {
  const company = companyComputer();
  const info = await fetch(
    `https://127.0.0.1:${company.office.port}/api/copilotkit/info`,
    {
      tls: {
        ca: company.cert.certificate,
        checkServerIdentity: () => undefined,
      },
    } as never,
  );
  expect((await info.json()).intelligence.wsUrl).toBe(
    `wss://127.0.0.1:${company.office.port}/api/hub/client`,
  );
});
