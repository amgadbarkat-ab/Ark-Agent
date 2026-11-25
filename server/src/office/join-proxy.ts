/**
 * A staff computer's way in to the company's ArkAgent (Amgad, 24 Nov 2026, option A).
 *
 * The desktop app on a staff computer runs this instead of a whole ArkAgent of its own. It answers
 * on this computer's loopback only, and passes every request and every live socket to the
 * administrator's computer over TLS that it checks itself.
 *
 * THE CERTIFICATE IS CHECKED ON EVERY CONNECTION (security review of v0.1.54, 25 Nov 2026). The
 * administrator's computer makes its own certificate, and the join code carries its SHA-256. Each
 * connection to the company's computer is made here with node:tls, and nothing is sent on it until
 * the certificate it presents has exactly that fingerprint. Before, the certificate was handed to
 * Bun as a trusted authority, and Bun ADDS that to the computer's own list: anybody on the network
 * with any publicly trusted certificate could stand in for the company's ArkAgent and read
 * passwords and chats. Requests and sockets now go, as plain HTTP on this computer's loopback, to
 * a bridge that makes that checked connection.
 *
 * No dependencies beyond Bun and node: it runs from the installed files as they are.
 */
import net from "node:net";
import tls from "node:tls";
import { withHubAddress, withSocketAllowed } from "./hub-socket";
import { type JoinCode, parseJoinCode } from "./join-code";

export type Upstream = {
  /** The company's computer as the page knows it: `https://<address>:<port>`. */
  origin: string;
  /** Its `Host`: `<address>:<port>`. */
  host: string;
  address: string;
  port: number;
};

type SocketData = {
  path: string;
  headers: Record<string, string>;
  upstream: Upstream;
  inward?: WebSocket;
  queued: (string | ArrayBuffer | Uint8Array)[];
};

const TIMEOUT_MS = 4000;
/** Hop-by-hop headers, and the ones the connection to the company's computer sets for itself. */
const DROP_REQUEST = [
  "host",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
];
const DROP_RESPONSE = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  // Bun decompresses what it fetches, so the length and encoding it was sent with are no longer true.
  "content-encoding",
  "content-length",
];

const fingerprintOf = (socket: tls.TLSSocket) =>
  (socket.getPeerCertificate()?.fingerprint256 ?? "")
    .replaceAll(":", "")
    .toLowerCase();

/**
 * A TLS connection to the company's computer, or null: null unless the certificate it presents has
 * exactly the join code's fingerprint. Which authority signed it, and which name it carries, do not
 * matter: only that fingerprint is trusted.
 */
export function checkedConnection(
  address: string,
  port: number,
  fingerprint: string,
): Promise<tls.TLSSocket | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: tls.TLSSocket | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const socket = tls.connect({
      host: address,
      port,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      done(null);
    }, TIMEOUT_MS);
    socket.once("secureConnect", () => {
      if (fingerprintOf(socket) === fingerprint) done(socket);
      else {
        socket.destroy();
        done(null);
      }
    });
    socket.once("error", () => {
      socket.destroy();
      done(null);
    });
  });
}

/** Finds the company's computer at one of its addresses, by the certificate the join code names. */
export async function findUpstream(code: JoinCode): Promise<Upstream | null> {
  for (const address of code.addresses) {
    const socket = await checkedConnection(
      address,
      code.port,
      code.fingerprint,
    );
    if (!socket) continue;
    socket.destroy();
    const host = `${address.includes(":") ? `[${address}]` : address}:${code.port}`;
    return { origin: `https://${host}`, host, address, port: code.port };
  }
  return null;
}

/**
 * The loopback bridge every request and socket goes through: each connection is held until the
 * company's computer has shown the right certificate, and dropped if it does not.
 */
function startBridge(
  code: JoinCode,
  current: () => Upstream | null,
  lost: () => void,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((client) => {
    const to = current();
    if (!to) {
      client.destroy();
      return;
    }
    const held: Buffer[] = [];
    let up: tls.TLSSocket | null = null;
    client.on("data", (chunk: Buffer) => {
      if (up) up.write(chunk);
      else held.push(chunk);
    });
    client.on("error", () => up?.destroy());
    client.on("close", () => up?.destroy());
    void checkedConnection(to.address, to.port, code.fingerprint).then(
      (socket) => {
        if (!socket || client.destroyed) {
          socket?.destroy();
          if (!socket) lost();
          client.destroy();
          return;
        }
        up = socket;
        for (const chunk of held.splice(0)) socket.write(chunk);
        socket.on("data", (chunk: Buffer) => client.write(chunk));
        socket.on("error", () => client.destroy());
        socket.on("close", () => client.destroy());
      },
    );
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => server.close(),
      }),
    ),
  );
}

function unreachable(request: Request, language: string): Response {
  const wantsPage = (request.headers.get("accept") ?? "").includes("text/html");
  const english = {
    title: "Your company's ArkAgent is not reachable",
    body: "The administrator's computer is off, asleep or not on this network. Ask them to open ArkAgent, then try again.",
  };
  const greek = {
    title: "Το ArkAgent της εταιρείας σας δεν είναι διαθέσιμο",
    body: "Ο υπολογιστής του διαχειριστή είναι κλειστός, σε αναστολή ή εκτός αυτού του δικτύου. Ζητήστε του να ανοίξει το ArkAgent και δοκιμάστε ξανά.",
  };
  if (!wantsPage)
    return Response.json(
      { error: english.title, code: "company_unreachable" },
      { status: 503 },
    );
  // The customer's language first, English below it.
  const first = language === "el" ? greek : english;
  const second = language === "el" ? english : null;
  const block = (text: typeof english, lang: string) =>
    `<section lang="${lang}"><h1>${text.title}</h1><p>${text.body}</p></section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ArkAgent</title><meta http-equiv="refresh" content="10"><style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:32rem}h1{font-size:1.25rem;font-weight:600}p{color:#a6abb8;line-height:1.5}section+section{margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid #23262f}</style></head><body><main>${block(first, language === "el" ? "el" : "en")}${second ? block(second, "en") : ""}</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** The proxy itself, given where to listen and the join code. Returned so it can be stopped. */
export async function startJoinProxy(options: {
  code: JoinCode;
  port: number;
  hostname?: string;
  language?: string;
  fetchImpl?: typeof fetch;
}) {
  const send = options.fetchImpl ?? fetch;
  const language = options.language ?? "en";
  let upstream: Upstream | null = null;
  let finding: Promise<Upstream | null> | null = null;

  async function current(): Promise<Upstream | null> {
    if (upstream) return upstream;
    finding ??= findUpstream(options.code).finally(() => {
      finding = null;
    });
    upstream = await finding;
    return upstream;
  }

  const bridge = await startBridge(
    options.code,
    () => upstream,
    () => {
      // The company's computer did not show its certificate: look for it again next time.
      upstream = null;
    },
  );
  const viaBridge = `127.0.0.1:${bridge.port}`;

  function outwardHeaders(request: Request, to: Upstream, local: string) {
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!DROP_REQUEST.includes(key.toLowerCase())) headers.set(key, value);
    });
    // The company's computer is addressed by its own name, though the bytes go through the bridge.
    headers.set("host", to.host);
    // The page is the company's ArkAgent, seen through this computer: to it, the request is its own.
    const origin = headers.get("origin");
    if (origin === local) headers.set("origin", to.origin);
    const referer = headers.get("referer");
    if (referer?.startsWith(`${local}/`))
      headers.set("referer", to.origin + referer.slice(local.length));
    return headers;
  }

  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    // Conversations with attachments are large; the same ceiling as the server.
    maxRequestBodySize: 64 * 1024 * 1024,
    idleTimeout: 255,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      /*
       * This computer's loopback only, by name as well as by address (security review of v0.1.54): a
       * web page that rebinds its own domain to 127.0.0.1 is refused, rather than having its
       * requests passed to the company's computer as the company's own.
       */
      const ownHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      if (!ownHosts.includes(request.headers.get("host")?.toLowerCase() ?? ""))
        return new Response("This address is not this ArkAgent.", {
          status: 421,
        });
      const local = url.origin;
      if (url.pathname === "/__ark_join/health") {
        const to = await current();
        return Response.json({ connected: to !== null });
      }
      const to = await current();
      if (!to) return unreachable(request, language);
      const target = `http://${viaBridge}${url.pathname}${url.search}`;

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers: Record<string, string> = {
          host: to.host,
          origin: to.origin,
        };
        const cookie = request.headers.get("cookie");
        if (cookie) headers.cookie = cookie;
        const protocol = request.headers.get("sec-websocket-protocol");
        if (protocol) headers["sec-websocket-protocol"] = protocol;
        if (
          bunServer.upgrade(request, {
            data: {
              path: url.pathname + url.search,
              headers,
              upstream: to,
              queued: [],
            },
          })
        )
          return undefined as unknown as Response;
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }

      try {
        const answer = await send(target, {
          method: request.method,
          headers: outwardHeaders(request, to, local),
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : request.body,
          redirect: "manual",
          // Lets a streamed body (a run's live answer) go on as long as it runs.
          duplex: "half",
        } as RequestInit);
        const headers = new Headers();
        answer.headers.forEach((value, key) => {
          if (DROP_RESPONSE.includes(key.toLowerCase())) return;
          if (key.toLowerCase() === "set-cookie") return;
          headers.set(key, value);
        });
        for (const cookie of answer.headers.getSetCookie())
          headers.append("set-cookie", cookie);
        const location = headers.get("location");
        if (location?.startsWith(to.origin))
          headers.set("location", local + location.slice(to.origin.length));
        const passed = withSocketAllowed(
          new Response(answer.body, {
            status: answer.status,
            statusText: answer.statusText,
            headers,
          }),
          local.replace(/^http/, "ws"),
        );
        // The hub's live connection, which the company's computer carries for the office network:
        // the page reaches it through this computer, like everything else.
        const remote = to.origin.replace(/^https/, "wss");
        const here = local.replace(/^http/, "ws");
        return url.pathname.startsWith("/api/copilotkit")
          ? withHubAddress(passed, (current) =>
              current.startsWith(remote)
                ? here + current.slice(remote.length)
                : null,
            )
          : passed;
      } catch {
        // The company's computer went away, or changed address: look for it again next time.
        upstream = null;
        return unreachable(request, language);
      }
    },
    websocket: {
      open(ws) {
        const data = ws.data;
        const inward = new WebSocket(`ws://${viaBridge}${data.path}`, {
          headers: data.headers,
        } as never);
        inward.binaryType = "arraybuffer";
        data.inward = inward;
        inward.onopen = () => {
          for (const message of data.queued.splice(0)) inward.send(message);
        };
        inward.onmessage = (event) => {
          try {
            ws.send(event.data as string | ArrayBuffer);
          } catch {
            inward.close();
          }
        };
        inward.onclose = (event) => ws.close(event.code || 1000, event.reason);
        inward.onerror = () => ws.close(1011, "The company's ArkAgent closed.");
      },
      message(ws, message) {
        const inward = ws.data.inward;
        if (inward?.readyState === WebSocket.OPEN) inward.send(message);
        else ws.data.queued.push(message);
      },
      close(ws) {
        ws.data.inward?.close();
      },
    },
  });

  return {
    port: server.port as number,
    stop: () => {
      server.stop(true);
      bridge.close();
    },
    /** Whether the company's computer was found, for the desktop's own check. */
    connected: async () => (await current()) !== null,
  };
}

// Run by the desktop app on a staff computer: `bun server/src/office/join-proxy.ts`.
if (import.meta.main) {
  const code = parseJoinCode(process.env.ARK_JOIN_CODE ?? "");
  const port = Number(process.env.ARK_JOIN_PORT);
  if (!code || !Number.isInteger(port) || port < 1) {
    console.error(
      JSON.stringify({
        type: "join-proxy-refused",
        reason: !code ? "not a join code" : "no port",
      }),
    );
    process.exit(2);
  }
  const proxy = await startJoinProxy({
    code,
    port,
    language: process.env.ARK_LANGUAGE?.trim() || "en",
  });
  console.log(
    JSON.stringify({ type: "join-proxy-listening", port: proxy.port }),
  );
}
