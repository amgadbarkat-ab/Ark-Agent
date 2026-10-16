import { describe, expect, test } from "bun:test";
import {
  createStarterModel,
  STARTER_CONNECTION_ID,
  StarterBusyError,
  type StarterModelConfig,
} from "../src/models/starter";

const encoder = new TextEncoder();

const config = (
  over: Partial<StarterModelConfig> = {},
): StarterModelConfig => ({
  baseUrl: "https://starter.example/v1",
  token: "operator-token",
  model: "gemma-4-e4b",
  concurrency: 1,
  maxWaitMs: 5_000,
  ...over,
});

/** An answer the test finishes by hand, the way a model finishes a stream. */
function answer() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (error: Error) => controller.error(error),
  };
}

type Call = { url: string; headers: Headers; method: string };

/** A server that hands out the prepared answers in order, and records what it was asked. */
function server(answers: Array<ReturnType<typeof answer> | Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: new Headers(init?.headers),
      method: (init?.method ?? "GET").toUpperCase(),
    });
    const next = answers.shift();
    if (!next) throw new Error("no answer prepared");
    return next instanceof Response ? next : next.response;
  };
  return { calls, fetchImpl };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const post = (url = "https://starter.example/v1/chat/completions") => ({
  url,
  init: { method: "POST", body: "{}" } satisfies RequestInit,
});

describe("the reserved connection id", () => {
  test("cannot be mistaken for a connection row's uuid", () => {
    expect(STARTER_CONNECTION_ID).toBe("ark-starter");
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        STARTER_CONNECTION_ID,
      ),
    ).toBe(false);
  });
});

describe("the queue", () => {
  test("answers one request at a time, and the second waits until the first stream has ended", async () => {
    const first = answer();
    const second = answer();
    const { calls, fetchImpl } = server([first, second]);
    const starter = createStarterModel(config(), { fetchImpl });

    const a = post();
    const b = post();
    const one = await starter.fetch(a.url, a.init);
    const twoPromise = starter.fetch(b.url, b.init);
    await tick();

    // The server has been asked once. The second person is in line.
    expect(calls).toHaveLength(1);
    expect(starter.status()).toMatchObject({ active: 1, waiting: 1 });

    // Reading the first answer to its end gives the turn up.
    first.push("hello");
    first.end();
    expect(await one.text()).toBe("hello");
    const two = await twoPromise;
    expect(calls).toHaveLength(2);
    expect(starter.status()).toMatchObject({ active: 1, waiting: 0 });
    second.end();
    await two.text();
    expect(starter.status()).toMatchObject({ active: 0, waiting: 0 });
  });

  test("holds the turn through the whole stream, not just until the first byte", async () => {
    const first = answer();
    const { calls, fetchImpl } = server([first, new Response("two")]);
    const starter = createStarterModel(config(), { fetchImpl });

    const one = await starter.fetch(post().url, post().init);
    const reader = one.body?.getReader();
    first.push("partial");
    await reader?.read();
    const waiting = starter.fetch(post().url, post().init);
    await tick();
    expect(calls).toHaveLength(1); // still the first person's turn

    first.end();
    await reader?.read(); // the end of the stream
    const second = await waiting;
    expect(await second.text()).toBe("two");
  });

  test("serves people in the order they asked", async () => {
    const first = answer();
    const { calls, fetchImpl } = server([
      first,
      new Response("b"),
      new Response("c"),
    ]);
    const starter = createStarterModel(config(), { fetchImpl });
    const one = await starter.fetch(
      post("https://starter.example/v1/a").url,
      post().init,
    );
    const b = starter.fetch("https://starter.example/v1/b", post().init);
    await tick();
    const c = starter.fetch("https://starter.example/v1/c", post().init);
    await tick();
    expect(starter.status().waiting).toBe(2);

    first.end();
    await one.text();
    await (await b).text();
    await (await c).text();
    expect(calls.map((call) => call.url.split("/").pop())).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("lets as many through at once as the operator allows", async () => {
    const first = answer();
    const second = answer();
    const { calls, fetchImpl } = server([first, second, new Response("x")]);
    const starter = createStarterModel(config({ concurrency: 2 }), {
      fetchImpl,
    });
    await starter.fetch(post().url, post().init);
    await starter.fetch(post().url, post().init);
    expect(calls).toHaveLength(2);
    const third = starter.fetch(post().url, post().init);
    await tick();
    expect(calls).toHaveLength(2);
    expect(starter.status()).toMatchObject({
      active: 2,
      waiting: 1,
      concurrency: 2,
    });
    first.end();
    await third;
    expect(calls).toHaveLength(3);
  });

  test("turns a request away with a sentence once it has waited its whole allowance", async () => {
    const first = answer();
    const { fetchImpl } = server([first]);
    const starter = createStarterModel(config({ maxWaitMs: 40 }), {
      fetchImpl,
    });
    await starter.fetch(post().url, post().init);

    const error = await starter.fetch(post().url, post().init).catch((e) => e);
    expect(error).toBeInstanceOf(StarterBusyError);
    expect(error.message).toContain("busy right now");
    expect(error.message).toContain("add your own model");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    // The one that gave up is not still in line.
    expect(starter.status().waiting).toBe(0);
    first.end();
  });

  test("a person who walks away while waiting leaves the line and takes nobody's turn", async () => {
    const first = answer();
    const { calls, fetchImpl } = server([first, new Response("c")]);
    const starter = createStarterModel(config(), { fetchImpl });
    const one = await starter.fetch(post().url, post().init);

    const walker = new AbortController();
    const gone = starter
      .fetch(post().url, { ...post().init, signal: walker.signal })
      .catch((e) => e);
    const next = starter.fetch(post().url, post().init);
    await tick();
    expect(starter.status().waiting).toBe(2);

    walker.abort();
    expect(await gone).toBeInstanceOf(Error);
    expect(starter.status().waiting).toBe(1);

    first.end();
    await one.text();
    await (await next).text();
    // The walker never reached the server; the person behind them did.
    expect(calls).toHaveLength(2);
  });

  test("a request already aborted does not take a turn", async () => {
    const { calls, fetchImpl } = server([]);
    const starter = createStarterModel(config(), { fetchImpl });
    const gone = AbortSignal.abort();
    await expect(
      starter.fetch(post().url, { ...post().init, signal: gone }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toHaveLength(0);
    expect(starter.status().active).toBe(0);
  });

  test("gives the turn back when the reader walks away mid-stream", async () => {
    const first = answer();
    const { fetchImpl } = server([first, new Response("next")]);
    const starter = createStarterModel(config(), { fetchImpl });
    const one = await starter.fetch(post().url, post().init);
    const waiting = starter.fetch(post().url, post().init);
    await tick();
    await one.body?.cancel();
    expect(await (await waiting).text()).toBe("next");
  });

  test("gives the turn back when the stream fails", async () => {
    const first = answer();
    const { fetchImpl } = server([first, new Response("next")]);
    const starter = createStarterModel(config(), { fetchImpl });
    const one = await starter.fetch(post().url, post().init);
    const waiting = starter.fetch(post().url, post().init);
    await tick();
    first.fail(new Error("the server went away"));
    await one.text().catch(() => undefined);
    expect(await (await waiting).text()).toBe("next");
  });

  test("gives the turn back when the server cannot be reached", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error("connect refused");
      return new Response("ok");
    };
    const starter = createStarterModel(config(), { fetchImpl });
    await expect(starter.fetch(post().url, post().init)).rejects.toThrow(
      "connect refused",
    );
    expect(starter.status().active).toBe(0);
    expect(await (await starter.fetch(post().url, post().init)).text()).toBe(
      "ok",
    );
  });

  test("gives the turn back at once for an answer with no body", async () => {
    const { fetchImpl } = server([new Response(null, { status: 204 })]);
    const starter = createStarterModel(config(), { fetchImpl });
    const response = await starter.fetch(post().url, post().init);
    expect(response.status).toBe(204);
    expect(starter.status().active).toBe(0);
  });
});

describe("what goes to the server", () => {
  test("carries the operator's token, in place of whatever the caller sent", async () => {
    const { calls, fetchImpl } = server([new Response("ok")]);
    const starter = createStarterModel(config(), { fetchImpl });
    await starter.fetch(post().url, {
      ...post().init,
      headers: {
        authorization: "Bearer a-bots-grant",
        "content-type": "application/json",
      },
    });
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer operator-token",
    );
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  test("sends no authorization at all when the operator set no token and the caller sent one", async () => {
    const { calls, fetchImpl } = server([new Response("ok")]);
    const starter = createStarterModel(config({ token: undefined }), {
      fetchImpl,
    });
    await starter.fetch(post().url, {
      ...post().init,
      headers: { authorization: "Bearer a-bots-grant" },
    });
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });

  test("asking which models exist does not wait behind somebody's answer", async () => {
    const first = answer();
    const { calls, fetchImpl } = server([first, new Response("[]")]);
    const starter = createStarterModel(config(), { fetchImpl });
    await starter.fetch(post().url, post().init);
    const models = await starter.fetch("https://starter.example/v1/models");
    expect(await models.text()).toBe("[]");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    first.end();
  });
});

describe("health", () => {
  test("is ready when the server lists its models, and the probe carries the token", async () => {
    const { calls, fetchImpl } = server([new Response("{}", { status: 200 })]);
    const starter = createStarterModel(config(), { fetchImpl });
    expect(await starter.health()).toBe("ready");
    expect(calls[0]?.url).toBe("https://starter.example/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer operator-token",
    );
  });

  test("is down when the server refuses or cannot be reached", async () => {
    const refusing = createStarterModel(config(), {
      fetchImpl: async () => new Response("no", { status: 401 }),
    });
    expect(await refusing.health()).toBe("down");
    const unreachable = createStarterModel(config(), {
      fetchImpl: async () => {
        throw new Error("timeout");
      },
    });
    expect(await unreachable.health()).toBe("down");
  });

  test("is asked about once however many screens ask, and again after the cache expires", async () => {
    let clock = 1_000;
    let probes = 0;
    const starter = createStarterModel(config(), {
      now: () => clock,
      fetchImpl: async () => {
        probes += 1;
        return new Response("{}");
      },
    });
    await Promise.all([starter.health(), starter.health(), starter.health()]);
    expect(probes).toBe(1);
    await starter.health();
    expect(probes).toBe(1);
    clock += 16_000;
    await starter.health();
    expect(probes).toBe(2);
  });
});
