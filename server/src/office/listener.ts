import type { Server, WebSocketHandler } from "bun";
import { type RemoteVia, viaOf } from "../host-access/remote-gate";
import { hostAllowed } from "./hosts";
import {
  HUB_PATH,
  type HubSocketData,
  hubSocket,
  isHubSocket,
  joinTokenUser,
  withHubAddress,
  withSocketAllowed,
} from "./hub-socket";
import { asOwnOrigin } from "./service";

/**
 * What the office listener serves (Amgad, 24 Nov 2026, option A): the same app and API as this
 * computer's own listener, with three differences for a page that came in over the office network.
 *
 * - A same-origin request counts as the app's own (`asOwnOrigin`).
 * - The conversation hub's socket is carried at `HUB_PATH`, and the runtime names that address.
 * - The page's own socket address is allowed in its content security policy.
 */
export function officeServeOptions<Data>(
  base: {
    fetch: (
      this: Server<Data>,
      request: Request,
      server: Server<Data>,
    ) => Response | undefined | Promise<Response | undefined>;
    websocket: WebSocketHandler<Data>;
  },
  options: {
    appOrigin: string;
    hub: string;
    /** Names this computer answers to on the office network, beside its addresses. */
    ownNames?: () => readonly string[];
    /**
     * Whether this person may still use ArkAgent (an unpaid, suspended or removed sub-profile may
     * not). The hub's socket is refused, and closed within seconds later, when they may not.
     */
    mayUse?: (userId: string) => Promise<boolean>;
    /**
     * Told when a person's conversation socket opens over this listener, and on each message they
     * send through it (v0.1.57): they are using ArkAgent from another computer, so their own browser
     * here asks before it is used (host-access/remote-gate.ts).
     */
    remoteSeen?: (userId: string, via: RemoteVia) => void;
  },
) {
  type Both = Data | HubSocketData;
  const socket = base.websocket as unknown as WebSocketHandler<Both>;
  return {
    async fetch(request: Request, server: Server<Both>) {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? url.host;
      if (!hostAllowed(request.headers.get("host"), options.ownNames?.() ?? []))
        return new Response("This address is not this ArkAgent.", {
          status: 421,
        });
      if (
        url.pathname === HUB_PATH &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const userId = joinTokenUser(url.search);
        if (!userId) return new Response("Sign in first.", { status: 401 });
        if (
          options.mayUse &&
          !(await options.mayUse(userId).catch(() => false))
        )
          return new Response("No longer allowed to use this ArkAgent.", {
            status: 403,
          });
        const via = viaOf(server, request);
        options.remoteSeen?.(userId, via);
        if (
          (server as unknown as Server<HubSocketData>).upgrade(request, {
            data: {
              hub: options.hub + url.search,
              queued: [],
              userId,
              via,
              ...(options.mayUse ? { mayUse: options.mayUse } : {}),
            },
          })
        )
          return undefined as unknown as Response;
        return new Response("Expected a WebSocket upgrade.", { status: 400 });
      }
      const answer = await base.fetch.call(
        server as unknown as Server<Data>,
        asOwnOrigin(request, options.appOrigin),
        server as unknown as Server<Data>,
      );
      if (!answer) return answer as unknown as Response;
      const own = withSocketAllowed(answer, `wss://${host}`);
      return url.pathname.startsWith("/api/copilotkit")
        ? withHubAddress(own, () => `wss://${host}${HUB_PATH}`)
        : own;
    },
    websocket: {
      ...socket,
      open(ws) {
        if (isHubSocket(ws.data)) hubSocket.open(ws as never);
        else socket.open?.(ws);
      },
      message(ws, message) {
        if (isHubSocket(ws.data)) {
          const data = ws.data as HubSocketData;
          if (data.userId && data.via)
            options.remoteSeen?.(data.userId, data.via);
          hubSocket.message(ws as never, message);
        } else socket.message(ws, message);
      },
      close(ws, code, reason) {
        if (isHubSocket(ws.data)) hubSocket.close(ws as never);
        else socket.close?.(ws, code, reason);
      },
    } satisfies WebSocketHandler<Both>,
  };
}
