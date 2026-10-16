import { afterAll, describe, expect, test } from "bun:test";
import {
  parseArguments,
  render,
  sample,
  summarise,
} from "./starter-model-benchmark";

const encoder = new TextEncoder();
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

/** A model server that streams `pieces` words, then (optionally) a usage report, then [DONE]. */
function fakeModel(options: {
  pieces: number;
  usage?: number;
  status?: number;
  delayMs?: number;
}) {
  const seen: Array<{ authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      if (options.status && options.status !== 200) {
        return new Response("no", { status: options.status });
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let index = 0; index < options.pieces; index += 1) {
            if (options.delayMs) await Bun.sleep(options.delayMs);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: `w${index} ` } }] })}\n\n`,
              ),
            );
          }
          if (options.usage !== undefined) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: options.usage } })}\n\n`,
              ),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1`, seen };
}

const args = (url: string, extra: string[] = []) =>
  parseArguments([
    "--url",
    url,
    "--token",
    "t0ken",
    "--model",
    "m",
    "--max-tokens",
    "50",
    ...extra,
  ]);

describe("arguments", () => {
  test("need an address, and refuse nonsense", () => {
    expect(() => parseArguments([])).toThrow("--url");
    expect(() =>
      parseArguments(["--url", "http://x/v1", "--users", "0,2"]),
    ).toThrow("--users");
    expect(() =>
      parseArguments(["--url", "http://x/v1", "--prompt", "klingon"]),
    ).toThrow("--prompt");
  });

  test("read the levels and drop a trailing slash", () => {
    const options = parseArguments([
      "--url",
      "http://x/v1/",
      "--users",
      "1,2",
      "--json",
    ]);
    expect(options.url).toBe("http://x/v1");
    expect(options.users).toEqual([1, 2]);
    expect(options.json).toBe(true);
  });
});

describe("one person asking", () => {
  test("times the first word and uses the server's own token count", async () => {
    const model = fakeModel({ pieces: 6, usage: 40, delayMs: 5 });
    const result = await sample(args(model.url));
    expect(result.ok).toBe(true);
    expect(result.tokens).toBe(40);
    expect(result.tokensSource).toBe("usage");
    expect(result.firstWordSeconds).toBeGreaterThan(0);
    expect(result.tokensPerSecond).toBeGreaterThan(0);
    expect(model.seen[0]?.authorization).toBe("Bearer t0ken");
    expect(model.seen[0]?.body).toMatchObject({
      model: "m",
      stream: true,
      max_tokens: 50,
    });
  });

  test("counts streamed pieces when the server sends no usage", async () => {
    const model = fakeModel({ pieces: 8, delayMs: 2 });
    const result = await sample(args(model.url));
    expect(result.tokens).toBe(8);
    expect(result.tokensSource).toBe("pieces");
  });

  test("reports a refusal and a connection that fails", async () => {
    const refusing = fakeModel({ pieces: 1, status: 401 });
    expect(await sample(args(refusing.url))).toMatchObject({
      ok: false,
      error: "HTTP 401",
    });
    const gone = await sample(args("http://127.0.0.1:1/v1"));
    expect(gone.ok).toBe(false);
    expect(gone.error).toBeTruthy();
  });

  test("an answer with no words in it is a failure, not a fast success", async () => {
    const model = fakeModel({ pieces: 0 });
    expect(await sample(args(model.url))).toMatchObject({
      ok: false,
      error: "no answer came back",
    });
  });
});

describe("the summary", () => {
  test("takes the slowest first word and the slowest speed, and counts failures", async () => {
    const model = fakeModel({ pieces: 5, usage: 20, delayMs: 3 });
    const options = args(model.url);
    const samples = await Promise.all([
      sample(options),
      sample(options),
      sample({ ...options, url: "http://127.0.0.1:1/v1" }),
    ]);
    const level = summarise(3, samples);
    expect(level.failures).toBe(1);
    expect(level.worstFirstWordSeconds).toBeGreaterThan(0);
    expect(level.worstTokensPerSecond).toBeGreaterThan(0);
  });

  test("says whether one person's speed is usable", () => {
    const options = parseArguments(["--url", "http://x/v1"]);
    const slow = summarise(1, [
      {
        ok: true,
        firstWordSeconds: 9,
        totalSeconds: 40,
        tokens: 50,
        tokensSource: "usage",
        tokensPerSecond: 1.5,
      },
    ]);
    const fast = summarise(1, [
      {
        ok: true,
        firstWordSeconds: 2,
        totalSeconds: 12,
        tokens: 50,
        tokensSource: "usage",
        tokensPerSecond: 6,
      },
    ]);
    expect(render(options, [slow])).toContain("too slow");
    expect(render(options, [fast])).toContain("usable for a first message");
    expect(render(options, [fast])).toContain("usage report");
  });
});
