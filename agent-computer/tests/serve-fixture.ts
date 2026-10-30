/**
 * A small server on `serve` from src/serve.ts, for serve.test.ts to run under Bun and under Node.
 *
 * The handlers use the same calls index.ts makes (a token in the query on the upgrade, data on the
 * socket, the request's signal, a handler that throws), so a difference between the two runtimes in
 * any of them shows up as one test failing on one of them. Prints the port it answers on.
 */
import { serve } from "../src/serve";

const TOKEN = "fixture-token";
let aborted = false;
let closed = 0;

const running = await serve<{ name: string }>({
  port: 0,
  hostname: "127.0.0.1",
  // Short, so a test can wait past it.
  idleTimeout: 2,
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello", name: ws.data.name }));
    },
    message(ws, raw) {
      if (String(raw) === "close") {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: "echo", text: String(raw) }));
    },
    close() {
      closed += 1;
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.searchParams.get("token") !== TOKEN) {
      return Response.json({ error: "Not authorised." }, { status: 401 });
    }
    if (url.pathname === "/stream") {
      if (
        server.upgrade(request, {
          data: { name: url.searchParams.get("name") ?? "" },
        })
      ) {
        return undefined;
      }
      return Response.json(
        { error: "Expected a WebSocket upgrade." },
        { status: 400 },
      );
    }
    if (url.pathname === "/echo") {
      return Response.json({
        method: request.method,
        header: request.headers.get("x-openbot-bot-id"),
        body: await request.json(),
      });
    }
    if (url.pathname === "/slow") {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
      aborted = true;
      return Response.json({ late: true });
    }
    if (url.pathname === "/state") {
      return Response.json({ aborted, closed });
    }
    if (url.pathname === "/throw") {
      throw new Error("a handler that throws");
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.log(`listening ${running.port}`);
