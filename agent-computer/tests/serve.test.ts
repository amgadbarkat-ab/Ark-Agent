import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { headersOf, rawResponse, requestUrl } from "../src/serve";

/**
 * The server on both runtimes it runs under (src/serve.ts).
 *
 * Bun is `Bun.serve`; Node is node:http and `ws` made to behave like it, because Windows has to run
 * this process under Node and every handler in index.ts is written against Bun's shape. So the same
 * fixture runs under each, and each case asks something index.ts depends on. The Node half needs a
 * Node 22 or newer on the PATH and `ws` installed; without either it says so and skips rather than
 * passing.
 */

const DIRECTORY = join(import.meta.dir, "..");
const TOKEN = "fixture-token";

function nodeMajor(): number {
  const answer = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (answer.status !== 0) return 0;
  return Number(/^v(\d+)/.exec(answer.stdout.trim())?.[1] ?? 0);
}
function hasWs(): boolean {
  try {
    Bun.resolveSync("ws/package.json", DIRECTORY);
    return true;
  } catch {
    return false;
  }
}
const hasNode = nodeMajor() >= 22 && hasWs();
if (!hasNode) {
  console.warn(
    "No Node 22 or newer, or no `ws`, here; the Node server is not exercised.",
  );
}

describe("the pieces the Node server is made of", () => {
  test("a request's address comes from its Host, or from this server when the Host is not one", () => {
    expect(requestUrl("/read?x=1", "127.0.0.1:4100", "0.0.0.0:1").href).toBe(
      "http://127.0.0.1:4100/read?x=1",
    );
    const fallback = requestUrl(
      "/stream?bot=ana",
      "not a host/",
      "127.0.0.1:4100",
    );
    expect(fallback.pathname).toBe("/stream");
    expect(fallback.searchParams.get("bot")).toBe("ana");
  });

  test("headers arrive as sent, repeats kept", () => {
    const headers = headersOf([
      "X-OpenBot-Bot-Id",
      "ana",
      "Accept",
      "a",
      "Accept",
      "b",
    ]);
    expect(headers.get("x-openbot-bot-id")).toBe("ana");
    expect(headers.get("accept")).toBe("a, b");
  });

  test("a refused upgrade is answered with the handler's response, then closed", async () => {
    const written = (
      await rawResponse(
        Response.json({ error: "Not authorised." }, { status: 401 }),
      )
    ).toString();
    const [head, body] = written.split("\r\n\r\n");
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
    expect(head).toContain("content-type: application/json");
    expect(head).toContain("connection: close");
    expect(head).toContain(`content-length: ${body.length}`);
    expect(JSON.parse(body)).toEqual({ error: "Not authorised." });
  });
});

type Running = { base: string; child: ChildProcess };

async function start(command: string, args: string[]): Promise<Running> {
  const child = spawn(command, args, {
    cwd: DIRECTORY,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({
    input: child.stdout as NonNullable<typeof child.stdout>,
  });
  const port = await new Promise<string>((resolve, reject) => {
    child.once("exit", (code) =>
      reject(new Error(`the fixture exited ${code}`)),
    );
    lines.on("line", (line) => {
      const found = /^listening (\d+)$/.exec(line);
      if (found) resolve(found[1]);
    });
  });
  return { base: `127.0.0.1:${port}`, child };
}

const runtimes: Array<[string, boolean, () => Promise<Running>]> = [
  ["Bun", true, () => start(process.execPath, ["tests/serve-fixture.ts"])],
  [
    "Node",
    hasNode,
    async () => {
      // Built as `build:node` builds index.ts, into the ignored dist folder so `ws` resolves from
      // this directory's node_modules.
      const built = await Bun.build({
        entrypoints: [join(DIRECTORY, "tests", "serve-fixture.ts")],
        target: "node",
        format: "esm",
        packages: "external",
        outdir: join(DIRECTORY, "dist"),
        naming: "serve-fixture.mjs",
      });
      if (!built.success) throw new Error(String(built.logs));
      return start("node", ["dist/serve-fixture.mjs"]);
    },
  ],
];

function socketTo(url: string): {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  opened: Promise<boolean>;
  closed: Promise<void>;
} {
  const socket = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("close", () => resolve(false));
  });
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve());
  });
  return { socket, messages, opened, closed };
}

async function until(what: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (what()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${why}`);
}

for (const [name, available, launch] of runtimes) {
  describe.skipIf(!available)(`the server under ${name}`, () => {
    let running: Running;
    const http = (path: string) => `http://${running.base}${path}`;
    const state = async () =>
      (await (await fetch(http(`/state?token=${TOKEN}`))).json()) as {
        aborted: boolean;
        closed: number;
      };

    beforeAll(async () => {
      running = await launch();
    }, 30_000);

    afterAll(() => {
      running?.child.kill("SIGKILL");
    });

    test("a request carries its method, headers and body to the handler", async () => {
      const response = await fetch(http(`/echo?token=${TOKEN}`), {
        method: "POST",
        headers: {
          "x-openbot-bot-id": "ana",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({
        method: "POST",
        header: "ana",
        body: { url: "https://example.com/" },
      });
    });

    test("the handler's status is the status, and a refusal reads the same", async () => {
      const refused = await fetch(http("/echo"));
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: "Not authorised." });
    });

    test("a handler that throws is a 500, and the server carries on", async () => {
      expect((await fetch(http(`/throw?token=${TOKEN}`))).status).toBe(500);
      expect((await fetch(http(`/state?token=${TOKEN}`))).status).toBe(200);
    });

    test("the caller going away aborts the request's signal, which is how Stop reaches an action", async () => {
      const caller = new AbortController();
      const pending = fetch(http(`/slow?token=${TOKEN}`), {
        method: "POST",
        body: "{}",
        signal: caller.signal,
      }).catch(() => undefined);
      await Bun.sleep(200);
      caller.abort();
      await pending;
      let aborted = false;
      const deadline = Date.now() + 5_000;
      while (!aborted && Date.now() < deadline) {
        aborted = (await state()).aborted;
        if (!aborted) await Bun.sleep(20);
      }
      expect(aborted).toBe(true);
    }, 10_000);

    test("an ordinary request to the stream is not upgraded", async () => {
      const response = await fetch(http(`/stream?token=${TOKEN}`));
      expect(response.status).toBe(400);
    });

    test("an upgrade without the token is refused and never opens", async () => {
      const { opened } = socketTo(`ws://${running.base}/stream?name=ana`);
      expect(await opened).toBe(false);
    });

    test("the live screen: data on the socket, messages both ways, and close reaches the handler", async () => {
      const before = (await state()).closed;
      const { socket, messages, opened, closed } = socketTo(
        `ws://${running.base}/stream?name=ana&token=${TOKEN}`,
      );
      expect(await opened).toBe(true);
      await until(() => messages.length > 0, "the greeting");
      expect(messages[0]).toEqual({ type: "hello", name: "ana" });
      socket.send(JSON.stringify({ type: "key", key: "." }));
      await until(() => messages.length > 1, "the echo");
      expect(messages[1]).toEqual({
        type: "echo",
        text: JSON.stringify({ type: "key", key: "." }),
      });
      socket.close();
      await closed;
      const after = async () => (await state()).closed;
      const deadline = Date.now() + 5_000;
      while ((await after()) === before && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(await after()).toBe(before + 1);
    });

    test("a quiet screen whose viewer is still there outlives the idle timeout", async () => {
      // The fixture's idle timeout is two seconds. Nothing is sent for longer than that, and the
      // socket must still carry a message afterwards: being watched without typing is not idle.
      const { socket, messages, opened } = socketTo(
        `ws://${running.base}/stream?name=quiet&token=${TOKEN}`,
      );
      expect(await opened).toBe(true);
      await Bun.sleep(5_000);
      socket.send("still here");
      await until(
        () => messages.some((message) => message.text === "still here"),
        "the echo after a quiet spell",
      );
      socket.close();
    }, 15_000);

    test("the server can close a socket", async () => {
      const { socket, opened, closed } = socketTo(
        `ws://${running.base}/stream?name=ben&token=${TOKEN}`,
      );
      expect(await opened).toBe(true);
      socket.send("close");
      await closed;
    });
  });
}
