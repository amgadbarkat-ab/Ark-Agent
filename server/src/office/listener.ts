import type { Server, WebSocketHandler } from "bun";
import {
  HUB_PATH,
  type HubSocketData,
  hubSocket,
  isHubSocket,
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
  options: { appOrigin: string; hub: string },
) {
  type Both = Data | HubSocketData;
  const socket = base.websocket as unknown as WebSocketHandler<Both>;
  return {
    async fetch(request: Request, server: Server<Both>) {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? url.host;
      if (
        url.pathname === HUB_PATH &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        if (
          (server as unknown as Server<HubSocketData>).upgrade(request, {
            data: { hub: options.hub + url.search, queued: [] },
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
        if (isHubSocket(ws.data)) hubSocket.message(ws as never, message);
        else socket.message(ws, message);
      },
      close(ws, code, reason) {
        if (isHubSocket(ws.data)) hubSocket.close(ws as never);
        else socket.close?.(ws, code, reason);
      },
    } satisfies WebSocketHandler<Both>,
  };
}
