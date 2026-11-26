/**
 * The conversation hub's live connection, carried for the office network (Amgad, 24 Nov 2026).
 *
 * A chat page opens a socket straight to the conversation hub, at the address the runtime's `/info`
 * names. On the administrator's computer that is the hub's loopback address, which is right there
 * and nowhere else: a staff computer reaching it would reach its own loopback, where there is no hub.
 * So the office listener carries the hub's client socket on its own address (`HUB_PATH`), and tells
 * a page that came in over the office network to use that one. The hub still checks every join
 * token itself; this only carries the bytes.
 */
export const HUB_PATH = "/api/hub/client";

export type HubSocketData = {
  hub: string;
  inward?: WebSocket;
  queued: (string | ArrayBuffer | Uint8Array)[];
  /** Whose join token opened it, and the check that they may still use ArkAgent. */
  userId?: string;
  /** How it reached this computer: the office network or BlackArk's relay (v0.1.57). */
  via?: "office network" | "relay";
  mayUse?: (userId: string) => Promise<boolean>;
  recheck?: ReturnType<typeof setInterval>;
};

/** How often a carried socket's person is checked again (security review of v0.1.55, R4). */
export const RECHECK_MS = 10_000;

/**
 * The person a join token names, read without checking its signature: the hub checks that itself,
 * and refuses the socket if it was forged, so a made-up id here never gets a socket. Used only to
 * refuse earlier, never to let anybody in.
 */
export function joinTokenUser(search: string): string | null {
  const token = new URLSearchParams(search).get("join_token") ?? "";
  const body = token.split(".")[0] ?? "";
  try {
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as {
      s?: { userId?: unknown };
    };
    return typeof claims.s?.userId === "string" ? claims.s.userId : null;
  } catch {
    return null;
  }
}

export const isHubSocket = (data: unknown): data is HubSocketData =>
  typeof (data as HubSocketData | undefined)?.hub === "string";

/** The hub's client socket, from the gateway address the deployment is configured with. */
export function hubClientUrl(gatewayWsUrl: string): string {
  const base = gatewayWsUrl.replace(/\/+$/, "");
  for (const end of ["/client", "/runner", "/channels"])
    if (base.endsWith(end)) return `${base.slice(0, -end.length)}/client`;
  return `${base}/client`;
}

type Socket = {
  data: HubSocketData;
  send: (message: string | ArrayBuffer | Uint8Array) => unknown;
  close: (code?: number, reason?: string) => void;
};

/** Both ways, and what the page sends before the hub has answered is held, not lost. */
export const hubSocket = {
  open(ws: Socket) {
    const { userId, mayUse } = ws.data;
    if (userId && mayUse)
      ws.data.recheck = setInterval(() => {
        void mayUse(userId)
          .catch(() => false)
          .then((still) => {
            if (still) return;
            ws.data.inward?.close();
            ws.close(4403, "No longer allowed to use this ArkAgent.");
          });
      }, RECHECK_MS);
    const inward = new WebSocket(ws.data.hub);
    inward.binaryType = "arraybuffer";
    ws.data.inward = inward;
    inward.onopen = () => {
      for (const message of ws.data.queued.splice(0)) inward.send(message);
    };
    inward.onmessage = (event) => {
      try {
        ws.send(event.data as string | ArrayBuffer);
      } catch {
        inward.close();
      }
    };
    inward.onclose = (event) => ws.close(event.code || 1000, event.reason);
    inward.onerror = () => ws.close(1011, "The conversation hub closed.");
  },
  message(ws: Socket, message: string | ArrayBuffer | Uint8Array) {
    const inward = ws.data.inward;
    if (inward?.readyState === WebSocket.OPEN) inward.send(message);
    else ws.data.queued.push(message);
  },
  close(ws: Socket) {
    if (ws.data.recheck) clearInterval(ws.data.recheck);
    ws.data.inward?.close();
  },
};

/**
 * A page's own socket address added to the policy's `connect-src`: not every browser counts `ws:`
 * as `'self'`, and the page was served from an address the policy could not have named.
 */
export function withSocketAllowed(response: Response, socketOrigin: string) {
  const policy = response.headers.get("content-security-policy");
  if (!policy || policy.includes(` ${socketOrigin}`)) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    policy.replace("connect-src ", `connect-src ${socketOrigin} `),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The runtime's answer with the hub's address replaced by `wsUrl`, where it names one. Only a small
 * JSON answer is read; anything else (a stream, a page) passes as it is.
 */
export async function withHubAddress(
  response: Response,
  wsUrl: (current: string) => string | null,
): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  const length = Number(response.headers.get("content-length") ?? "0");
  if (!type.includes("application/json") || length > 1_000_000) return response;
  const text = await response.text();
  const remade = (body: string) => {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  try {
    const body = JSON.parse(text) as { intelligence?: { wsUrl?: unknown } };
    const current = body.intelligence?.wsUrl;
    if (typeof current !== "string") return remade(text);
    const next = wsUrl(current);
    if (!next || !body.intelligence) return remade(text);
    body.intelligence.wsUrl = next;
    return remade(JSON.stringify(body));
  } catch {
    return remade(text);
  }
}
