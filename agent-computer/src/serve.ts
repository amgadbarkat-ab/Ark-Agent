/**
 * The HTTP server and the live screen's websocket, on whichever runtime started this process.
 *
 * WHY THERE ARE TWO. Containers, macOS and Linux run this under Bun, and there it is `Bun.serve`,
 * passed the same options it has always had. Windows cannot: Playwright drives the person's Chrome or
 * Edge over a pipe on extra file descriptors, and Bun on Windows cannot hand a child those, so the
 * launch times out. Node can, so on Windows this process runs under Node (the desktop starts it with
 * `dist/own-browser.mjs`, built by `bun run build:node`), and Node has no `Bun.serve`. Connecting to
 * the browser some other way was tried and does not help: under Bun on Windows, CDP over a debugging
 * port and a Playwright server both hang at the websocket handshake (docs/ark/25-device-control.md).
 *
 * THE CONTRACT. `index.ts` is written against Bun's shape: a `fetch` handler that may call
 * `server.upgrade(request, { data })`, and `open`, `message` and `close` handlers given a socket with
 * `data`, `send` and `close`. The Node half reproduces that shape on `node:http` and `ws`, so the
 * handlers are the same code on both and nothing about routes, tokens or the live-screen protocol can
 * differ between platforms. What it adds is only what Bun does for free: the request's signal aborts
 * when the caller goes away, an upgrade the handler refuses gets the handler's answer, and a socket
 * whose peer has gone quiet is closed after the idle timeout.
 *
 * `ws` is imported only on Node. Bun substitutes its own module for that name, and it is not needed
 * there.
 */
import {
  createServer,
  type IncomingMessage,
  STATUS_CODES,
  type ServerResponse,
} from "node:http";
import { type Duplex, Readable } from "node:stream";
import type { WebSocket as NodeWebSocket } from "ws";

/** A live-screen connection, as the handlers see it on either runtime. */
export type ComputerSocket<T> = {
  readonly data: T;
  send(message: string): unknown;
  close(): void;
};

/** What the `fetch` handler may do with a request besides answering it. */
export type ComputerServer<T> = {
  /** Take the request over as a websocket carrying `data`. False when it is not an upgrade. */
  upgrade(request: Request, options: { data: T }): boolean;
};

export type ServeOptions<T> = {
  port: number;
  /** Absent binds every interface, as Bun does. */
  hostname?: string;
  /** Seconds a connection may sit with nothing received before it is closed. */
  idleTimeout: number;
  websocket: {
    open(ws: ComputerSocket<T>): unknown;
    message(ws: ComputerSocket<T>, message: string | Buffer): unknown;
    close(ws: ComputerSocket<T>): unknown;
  };
  fetch(
    request: Request,
    server: ComputerServer<T>,
  ): Response | undefined | Promise<Response | undefined>;
};

export type RunningServer = {
  /** The port it answers on, which is the one asked for unless that was 0. */
  port: number;
  stop(): Promise<void>;
};

/** Bun's default, kept so a frame is refused at the same size on both runtimes. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export async function serve<T>(
  options: ServeOptions<T>,
): Promise<RunningServer> {
  if (process.versions.bun) {
    // The options index.ts has always passed, untouched. The cast only bridges this file's narrower
    // socket and server types to Bun's own, which carry more than the handlers use.
    const server = Bun.serve<T>(
      options as unknown as Parameters<typeof Bun.serve<T>>[0],
    );
    return {
      port: server.port ?? options.port,
      stop: () => server.stop(true),
    };
  }
  return serveOnNode(options);
}

/**
 * The address a request was made to, as a URL.
 *
 * Bun builds `request.url` from the Host header. A Host header that is not a host would make that
 * throw here, before any handler could refuse the request, so it falls back to the address this
 * server answers on: the handlers read the path and the query, never the host.
 */
export function requestUrl(
  path: string | undefined,
  host: string | undefined,
  fallbackHost: string,
): URL {
  try {
    return new URL(path ?? "/", `http://${host ?? fallbackHost}`);
  } catch {
    return new URL(path ?? "/", `http://${fallbackHost}`);
  }
}

/** The headers Node received, in the order they came, repeats kept. */
export function headersOf(raw: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    try {
      headers.append(raw[index], raw[index + 1]);
    } catch {
      // A header Node accepted and the Fetch API will not hold. Not one any handler here reads.
    }
  }
  return headers;
}

/**
 * The handler's answer to an upgrade it refused, written straight to the socket.
 *
 * Bun sends the response `fetch` returned when it did not upgrade, which is how a client without the
 * token hears 401 rather than a dropped connection. Node hands an upgrade over as a bare socket, so
 * the answer is written by hand and the connection closed after it.
 */
export async function rawResponse(response: Response): Promise<Buffer> {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`,
  ];
  for (const [name, value] of response.headers) {
    if (["connection", "content-length", "transfer-encoding"].includes(name)) {
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push(`content-length: ${body.length}`, "connection: close", "", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n")), body]);
}

async function serveOnNode<T>(
  options: ServeOptions<T>,
): Promise<RunningServer> {
  const { WebSocketServer } = await import("ws");
  const hostname = options.hostname ?? "0.0.0.0";
  // Where requests are taken to have been made when their Host header is unusable. Set again once
  // the port is known, which matters only when 0 asked for any.
  let local = `${hostname}:${options.port}`;
  const idleMs = options.idleTimeout * 1000;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });

  const failed = (error: unknown) => {
    console.error(
      JSON.stringify({ type: "computer-server-error", error: String(error) }),
    );
    return new Response("Internal Server Error", { status: 500 });
  };

  /** The handler's answer. None is right only for a request it upgraded. */
  async function answer(
    request: Request,
    server: ComputerServer<T>,
  ): Promise<Response | undefined> {
    try {
      return (await options.fetch(request, server)) ?? undefined;
    } catch (error) {
      return failed(error);
    }
  }
  const unanswered = () => failed("the handler gave no response");

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    // The caller going away is how Stop reaches an action in progress (index.ts), and Bun aborts the
    // signal when that happens. Here it is the response closing before it was finished.
    const caller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) caller.abort();
    });
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(requestUrl(req.url, req.headers.host, local), {
      method: req.method,
      headers: headersOf(req.rawHeaders),
      signal: caller.signal,
      ...(hasBody
        ? {
            body: Readable.toWeb(req) as unknown as ReadableStream,
            duplex: "half",
          }
        : {}),
    } as RequestInit);
    const response =
      (await answer(request, { upgrade: () => false })) ?? unanswered();
    try {
      res.statusCode = response.status;
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") res.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      // Every answer here is a small JSON body, so it is read whole rather than streamed.
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.destroy();
    }
  }

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Node leaves an upgraded socket with no error listener, and an unheard error ends the process.
    socket.on("error", () => socket.destroy());
    const isWebSocket = req.headers.upgrade?.toLowerCase() === "websocket";
    let accepted: { data: T } | undefined;
    const request = new Request(requestUrl(req.url, req.headers.host, local), {
      method: req.method,
      headers: headersOf(req.rawHeaders),
    });
    const response = await answer(request, {
      upgrade(_request, upgrade) {
        if (!isWebSocket || accepted) return false;
        accepted = upgrade;
        return true;
      },
    });
    if (!accepted) {
      socket.end(await rawResponse(response ?? unanswered()));
      return;
    }
    const { data } = accepted;
    sockets.handleUpgrade(req, socket, head, (raw) => connected(raw, data));
  }

  /*
   * Bun closes a websocket that has received nothing for `idleTimeout` seconds, and pings it so a
   * peer that is merely quiet answers. The same here: a ping each half period, and a socket that
   * answered nothing since the last one is closed. A person watching the screen keeps it open; a
   * laptop lid closed on the surface does not hold a screencast open for ever.
   */
  const heard = new Map<NodeWebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const [raw, alive] of heard) {
      if (!alive) {
        raw.terminate();
        continue;
      }
      heard.set(raw, false);
      raw.ping();
    }
  }, idleMs / 2);
  heartbeat.unref();

  function connected(raw: NodeWebSocket, data: T) {
    const socket: ComputerSocket<T> = {
      data,
      send: (message) => raw.send(message),
      close: () => raw.close(),
    };
    const report = (work: () => unknown) => {
      // A handler that throws is logged, as Bun does. Unheard, a rejection would end the process.
      void Promise.resolve()
        .then(work)
        .catch((error) => failed(error));
    };
    heard.set(raw, true);
    raw.on("pong", () => heard.set(raw, true));
    raw.on("message", (message, isBinary) => {
      heard.set(raw, true);
      report(() =>
        options.websocket.message(
          socket,
          isBinary ? (message as Buffer) : message.toString(),
        ),
      );
    });
    // `ws` closes the socket after an error and reports it as a close, which is what is handled.
    raw.on("error", () => undefined);
    raw.on("close", () => {
      heard.delete(raw);
      report(() => options.websocket.close(socket));
    });
    report(() => options.websocket.open(socket));
  }

  const server = createServer((req, res) => void onRequest(req, res));
  server.on(
    "upgrade",
    (req, socket, head) => void onUpgrade(req, socket, head),
  );
  // Bun's idle timeout covers a connection waiting between requests as well as one going quiet.
  server.setTimeout(idleMs);
  server.keepAliveTimeout = idleMs;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;
  local = `${hostname}:${port}`;
  return {
    port,
    async stop() {
      clearInterval(heartbeat);
      for (const raw of heard.keys()) raw.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
