import { afterAll, describe, expect, test } from "bun:test";
import { providerById } from "../../shared/model-providers";
import { createAgentFetch } from "../src/agents/endpoint";
import { probeConnection } from "../src/models/probe";

type Handler = (request: Request) => Response | Promise<Response>;
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

function serve(handler: Handler) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
afterAll(() => {
  for (const server of servers) server.stop(true);
});

const lenient = createAgentFetch({ allowPrivateHosts: true });
const strict = createAgentFetch({ allowPrivateHosts: false });
const provider = (id: string) => {
  const found = providerById(id);
  if (!found) throw new Error(`no provider ${id}`);
  return found;
};

describe("probeConnection", () => {
  test("lists an OpenAI-style server's models, sorted and without repeats, sending the key as a bearer token", async () => {
    let seen: Headers | undefined;
    let path = "";
    const base = serve((request) => {
      seen = request.headers;
      path = new URL(request.url).pathname;
      return Response.json({
        data: [{ id: "b-model" }, { id: "a-model" }, { id: "b-model" }],
      });
    });
    const result = await probeConnection({
      provider: provider("openai-compatible"),
      baseUrl: `${base}/v1`,
      apiKey: "sk-test",
      fetchImpl: lenient,
    });
    expect(result).toEqual({ ok: true, models: ["a-model", "b-model"] });
    expect(path).toBe("/v1/models");
    expect(seen?.get("authorization")).toBe("Bearer sk-test");
  });

  test("sends no authorisation when there is no key, as a local server wants", async () => {
    let seen: Headers | undefined;
    const base = serve((request) => {
      seen = request.headers;
      return Response.json({ data: [{ id: "qwen3:8b" }] });
    });
    const result = await probeConnection({
      provider: provider("ollama"),
      baseUrl: `${base}/v1`,
      apiKey: null,
      fetchImpl: lenient,
    });
    expect(result).toEqual({ ok: true, models: ["qwen3:8b"] });
    expect(seen?.get("authorization")).toBeNull();
  });

  test("speaks Anthropic's dialect: its own header, a version, and /v1/models under a bare address", async () => {
    let seen: Headers | undefined;
    let path = "";
    const base = serve((request) => {
      seen = request.headers;
      path = new URL(request.url).pathname;
      return Response.json({ data: [{ id: "claude-sonnet-5" }] });
    });
    const result = await probeConnection({
      provider: { ...provider("anthropic"), baseUrl: base },
      baseUrl: base,
      apiKey: "sk-ant-test",
      fetchImpl: lenient,
    });
    expect(result).toEqual({ ok: true, models: ["claude-sonnet-5"] });
    expect(path).toBe("/v1/models");
    expect(seen?.get("x-api-key")).toBe("sk-ant-test");
    expect(seen?.get("anthropic-version")).toBeTruthy();
    expect(seen?.get("authorization")).toBeNull();
  });

  test("keeps only the models a provider's filter allows", async () => {
    const base = serve(() =>
      Response.json({
        data: [{ id: "x/paid-model" }, { id: "x/free-model:free" }],
      }),
    );
    const result = await probeConnection({
      provider: provider("openrouter-free"),
      baseUrl: base,
      apiKey: "k",
      fetchImpl: lenient,
    });
    expect(result).toEqual({ ok: true, models: ["x/free-model:free"] });
  });

  test("turns a refused key into a sentence, and never repeats the provider's own text", async () => {
    const base = serve(() =>
      Response.json(
        { error: { message: "Invalid key sk-leaky-secret-value" } },
        { status: 401 },
      ),
    );
    const result = await probeConnection({
      provider: provider("openai-compatible"),
      baseUrl: base,
      apiKey: "sk-leaky-secret-value",
      fetchImpl: lenient,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-leaky-secret-value");
    expect(result.ok === false && result.reason).toMatch(/refused the key/i);
  });

  test("explains a wrong address, a busy provider and a broken one", async () => {
    for (const [status, expected] of [
      [404, /did not recognise that address/i],
      [429, /allowance/i],
      [503, /problem on its side/i],
    ] as const) {
      const base = serve(() => new Response("nope", { status }));
      const result = await probeConnection({
        provider: provider("openai-compatible"),
        baseUrl: base,
        apiKey: null,
        fetchImpl: lenient,
      });
      expect(result.ok === false && result.reason).toMatch(expected);
    }
  });

  test("recognises an address that answers, but is not a model server", async () => {
    for (const body of ["<html>hello</html>", JSON.stringify({ models: [] })]) {
      const base = serve(() => new Response(body));
      const result = await probeConnection({
        provider: provider("openai-compatible"),
        baseUrl: base,
        apiKey: null,
        fetchImpl: lenient,
      });
      expect(result.ok === false && result.reason).toMatch(
        /not like|not with a list/i,
      );
    }
  });

  test("gives up on a server that does not answer, and on one that sends far too much", async () => {
    const slow = serve(async () => {
      await Bun.sleep(1500);
      return Response.json({ data: [] });
    });
    const timedOut = await probeConnection({
      provider: provider("openai-compatible"),
      baseUrl: slow,
      apiKey: null,
      fetchImpl: lenient,
      timeoutMs: 200,
    });
    expect(timedOut.ok === false && timedOut.reason).toMatch(/did not answer/i);

    const huge = serve(() => new Response("x".repeat(3 * 1024 * 1024)));
    const tooBig = await probeConnection({
      provider: provider("openai-compatible"),
      baseUrl: huge,
      apiKey: null,
      fetchImpl: lenient,
    });
    expect(tooBig.ok === false && tooBig.reason).toMatch(/far more than/i);
  });

  test("says so when nothing is listening", async () => {
    const result = await probeConnection({
      provider: provider("ollama"),
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: null,
      fetchImpl: lenient,
    });
    expect(result.ok === false && result.reason).toMatch(/could not reach/i);
  });

  test("a hosted deployment will not contact a private address", async () => {
    const base = serve(() => Response.json({ data: [{ id: "m" }] }));
    const result = await probeConnection({
      provider: provider("openai-compatible"),
      baseUrl: base,
      apiKey: null,
      fetchImpl: strict,
    });
    expect(result.ok).toBe(false);
  });

  test("a redirect to the cloud metadata address is refused even where private hosts are allowed", async () => {
    const base = serve(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    const result = await probeConnection({
      provider: provider("openai-compatible"),
      baseUrl: base,
      apiKey: "k",
      fetchImpl: lenient,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/will not dial|not/i);
  });
});
