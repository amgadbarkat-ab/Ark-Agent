import { afterEach, expect, test } from "bun:test";
import { makeOfficeCertificate } from "../src/office/certificate";
import type { JoinCode } from "../src/office/join-code";
import { startJoinProxy } from "../src/office/join-proxy";

/**
 * A staff computer's way in (Amgad, 24 Nov 2026, option A): everything goes to the company's
 * ArkAgent over HTTPS, trusting only the certificate the join code names.
 */
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type Seen = { path: string; origin: string | null; cookie: string | null };

/** The administrator's computer, as far as the proxy can tell. */
function company(
  cert = makeOfficeCertificate({ addresses: [], hostnames: [] }),
) {
  const seen: Seen[] = [];
  const server = Bun.serve<{ cookie: string | null; origin: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: cert.certificate, key: cert.key },
    async fetch(request, srv) {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname,
        origin: request.headers.get("origin"),
        cookie: request.headers.get("cookie"),
      });
      if (url.pathname === "/api/office/certificate")
        return new Response(cert.certificate);
      if (url.pathname === "/api/socket") {
        if (
          srv.upgrade(request, {
            data: {
              cookie: request.headers.get("cookie"),
              origin: request.headers.get("origin"),
            },
          })
        )
          return undefined as unknown as Response;
      }
      if (url.pathname === "/api/auth/sign-in/email") {
        return Response.json(
          { body: await request.text() },
          {
            headers: {
              "set-cookie": "better-auth.session_token=abc; Path=/; HttpOnly",
            },
          },
        );
      }
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
      if (url.pathname === "/go")
        return Response.redirect(`https://127.0.0.1:${srv.port}/sign`, 302);
      return new Response(`page ${url.pathname}`, {
        headers: { "content-type": "text/html" },
      });
    },
    websocket: {
      message(ws, message) {
        ws.send(`${ws.data.cookie} ${ws.data.origin} ${message}`);
      },
    },
  });
  stops.push(() => server.stop(true));
  const code: JoinCode = {
    addresses: ["127.0.0.1"],
    port: server.port as number,
    fingerprint: cert.fingerprint,
  };
  return { server, seen, code, cert };
}

async function proxy(code: JoinCode, language = "en") {
  const started = await startJoinProxy({ code, port: 0, language });
  stops.push(started.stop);
  return { ...started, local: `http://127.0.0.1:${started.port}` };
}

test("requests reach the company's ArkAgent as its own, with the sign-in cookie both ways", async () => {
  const { code, seen, server } = company();
  const { local } = await proxy(code);
  expect(await (await fetch(`${local}/__ark_join/health`)).json()).toEqual({
    connected: true,
    via: "office",
  });

  const signIn = await fetch(`${local}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: local, "content-type": "application/json" },
    body: JSON.stringify({ email: "nikos@shop.example" }),
  });
  expect(signIn.status).toBe(200);
  expect(signIn.headers.get("set-cookie")).toContain("session_token=abc");
  expect((await signIn.json()).body).toContain("nikos@shop.example");
  const company_ = `https://127.0.0.1:${server.port}`;
  expect(seen.at(-1)).toMatchObject({
    path: "/api/auth/sign-in/email",
    origin: company_,
  });

  await fetch(`${local}/channels`, {
    headers: { cookie: "better-auth.session_token=abc" },
  });
  expect(seen.at(-1)?.cookie).toBe("better-auth.session_token=abc");

  // A redirect to the company's own address comes back as this computer's.
  const moved = await fetch(`${local}/go`, { redirect: "manual" });
  expect(moved.headers.get("location")).toBe(`${local}/sign`);
});

test("a run's live answer streams through as it is written", async () => {
  const { code } = company();
  const { local } = await proxy(code);
  const response = await fetch(`${local}/api/stream`);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
});

test("live sockets go through, carrying the cookie, as the company's own page", async () => {
  const { code, server } = company();
  const { local } = await proxy(code);
  const socket = new WebSocket(`${local.replace("http", "ws")}/api/socket`, {
    headers: { cookie: "better-auth.session_token=abc", origin: local },
  } as never);
  const answer = await new Promise<string>((resolve, reject) => {
    // Sent at once: held until the company's side is open, not lost.
    socket.onopen = () => socket.send("hello");
    socket.onmessage = (event) => resolve(String(event.data));
    socket.onerror = () => reject(new Error("socket failed"));
    setTimeout(() => reject(new Error("timeout")), 4000);
  });
  expect(answer).toBe(
    `better-auth.session_token=abc https://127.0.0.1:${server.port} hello`,
  );
  socket.close();
});

test("a computer with another certificate is never trusted, whatever it says", async () => {
  const { code } = company();
  const impostor = makeOfficeCertificate({ addresses: [], hostnames: [] });
  const { local } = await proxy({ ...code, fingerprint: impostor.fingerprint });
  expect(await (await fetch(`${local}/__ark_join/health`)).json()).toEqual({
    connected: false,
    via: null,
  });
  const api = await fetch(`${local}/api/team/me`);
  expect(api.status).toBe(503);
  expect((await api.json()).code).toBe("company_unreachable");
});

test("when the company's computer is off, the page says so, in the customer's language first", async () => {
  const { code, server } = company();
  const { local } = await proxy(code, "el");
  expect((await fetch(`${local}/`)).status).toBe(200);
  server.stop(true);
  const page = await fetch(`${local}/channels`, {
    headers: { accept: "text/html" },
  });
  expect(page.status).toBe(503);
  const html = await page.text();
  expect(html.indexOf("Το ArkAgent της εταιρείας σας")).toBeGreaterThan(-1);
  expect(html.indexOf("Το ArkAgent της εταιρείας σας")).toBeLessThan(
    html.indexOf("Your company's ArkAgent is not reachable"),
  );
});

test("a computer on the network with a certificate the system trusts, but not the company's, gets nothing", async () => {
  // The company's real computer is found first, then something else answers at its address.
  const { code, server } = company();
  const { local } = await proxy(code);
  expect((await fetch(`${local}/api/x`)).status).toBe(200);
  const port = server.port as number;
  server.stop(true);
  // An impostor on the same address and port, with a certificate of its own. Which authority signed
  // it does not matter: only the join code's fingerprint is trusted.
  const impostor = makeOfficeCertificate({
    addresses: ["127.0.0.1"],
    hostnames: [],
  });
  const seen: string[] = [];
  const stand = Bun.serve({
    hostname: "127.0.0.1",
    port,
    tls: { cert: impostor.certificate, key: impostor.key },
    fetch(request, srv) {
      seen.push(
        `${request.method} ${new URL(request.url).pathname} ${request.headers.get("cookie") ?? ""}`,
      );
      if (srv.upgrade(request)) return undefined as unknown as Response;
      return new Response("impostor");
    },
    websocket: { message() {} },
  });
  stops.push(() => stand.stop(true));
  const answer = await fetch(`${local}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: local, cookie: "better-auth.session_token=abc" },
    body: JSON.stringify({ email: "maria@shop.example", password: "secret-1" }),
  });
  expect(await answer.text()).not.toContain("impostor");
  const socket = new WebSocket(`${local.replace("http", "ws")}/api/socket`, {
    headers: { cookie: "better-auth.session_token=abc" },
  } as never);
  await new Promise((resolve) => {
    socket.onclose = resolve;
    socket.onerror = resolve;
    setTimeout(resolve, 3000);
  });
  // Not one request, password or cookie reached it.
  expect(seen).toEqual([]);
});

test("a web page that renames itself to this computer is refused: only loopback, by name too", async () => {
  const { code } = company();
  const { local, port } = await proxy(code);
  const rebound = await fetch(`${local}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      host: `attacker.example:${port}`,
      origin: `http://attacker.example:${port}`,
    },
    body: "{}",
  });
  expect(rebound.status).toBe(421);
  expect((await fetch(`http://localhost:${port}/api/x`)).status).toBe(200);
});
