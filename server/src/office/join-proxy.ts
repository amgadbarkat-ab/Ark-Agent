/**
 * A staff computer's way in to the company's ArkAgent (Amgad, 24 Nov 2026, option A).
 *
 * The desktop app on a staff computer runs this instead of a whole ArkAgent of its own. It answers
 * on this computer's loopback only, and passes every request and every live socket to the
 * administrator's computer over HTTPS. The administrator's certificate is made by that computer
 * for itself, so no browser would trust it; this does, and only that exact one: the certificate is
 * fetched once and kept only if its SHA-256 matches the fingerprint in the join code. From then on
 * it is the only certificate trusted, so nobody on the network can stand in for the company's
 * ArkAgent even though the first fetch could not yet check who answered. Nothing is kept on this
 * computer, and each person still signs in with their own sub-profile.
 *
 * No dependencies beyond Bun and node:crypto: it runs from the installed files as they are.
 */
import { fingerprintOf } from "./certificate";
import { withHubAddress, withSocketAllowed } from "./hub-socket";
import { type JoinCode, parseJoinCode } from "./join-code";

export type Upstream = { origin: string; ca: string };

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

const pinned = (upstream: Upstream) => ({
  ca: upstream.ca,
  // The certificate is pinned above; the address it was reached at may have changed since it was made.
  checkServerIdentity: () => undefined,
});

/** Finds the company's computer at one of its addresses, and keeps its certificate if it is the one. */
export async function findUpstream(
  code: JoinCode,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Upstream | null> {
  const send = options.fetchImpl ?? fetch;
  for (const address of code.addresses) {
    const host = address.includes(":") ? `[${address}]` : address;
    const origin = `https://${host}:${code.port}`;
    try {
      const response = await send(`${origin}/api/office/certificate`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        tls: { rejectUnauthorized: false },
      } as RequestInit);
      if (!response.ok) continue;
      const pem = await response.text();
      if (fingerprintOf(pem) !== code.fingerprint) continue;
      return { origin, ca: pem };
    } catch {
      // Not there, or not answering: the next address.
    }
  }
  return null;
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
export function startJoinProxy(options: {
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
    finding ??= findUpstream(options.code, { fetchImpl: send }).finally(() => {
      finding = null;
    });
    upstream = await finding;
    return upstream;
  }

  function outwardHeaders(request: Request, to: Upstream, local: string) {
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!DROP_REQUEST.includes(key.toLowerCase())) headers.set(key, value);
    });
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
      const local = url.origin;
      if (url.pathname === "/__ark_join/health") {
        const to = await current();
        return Response.json({ connected: to !== null });
      }
      const to = await current();
      if (!to) return unreachable(request, language);
      const target = to.origin + url.pathname + url.search;

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers: Record<string, string> = { origin: to.origin };
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
          tls: pinned(to),
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
        const wsOrigin = data.upstream.origin.replace(/^https/, "wss");
        const inward = new WebSocket(wsOrigin + data.path, {
          headers: data.headers,
          tls: pinned(data.upstream),
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
    stop: () => server.stop(true),
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
  const proxy = startJoinProxy({
    code,
    port,
    language: process.env.ARK_LANGUAGE?.trim() || "en",
  });
  console.log(
    JSON.stringify({ type: "join-proxy-listening", port: proxy.port }),
  );
}
