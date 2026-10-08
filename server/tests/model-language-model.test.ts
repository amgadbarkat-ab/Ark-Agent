import { afterAll, describe, expect, test } from "bun:test";
import { createAgentFetch } from "../src/agents/endpoint";
import {
  languageModelFor,
  type ModelChoice,
} from "../src/models/language-model";

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

type Seen = { path: string; headers: Headers; body: Record<string, unknown> };

function serve(reply: (path: string) => unknown) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push({
        path,
        headers: request.headers,
        body: (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >,
      });
      return Response.json(reply(path));
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const prompt = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "say pong" }],
  },
];

const lenient = createAgentFetch({ allowPrivateHosts: true });

const chatReply = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "qwen3:8b",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "pong" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const messagesReply = {
  id: "m1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [{ type: "text", text: "pong" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
};

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.find((part) => part.type === "text")?.text;

describe("languageModelFor", () => {
  test("talks to an OpenAI-compatible server on its chat endpoint, as the person's key and model", async () => {
    const server = serve(() => chatReply);
    const choice: ModelChoice = {
      providerId: "groq",
      protocol: "openai",
      baseUrl: `${server.url}/openai/v1`,
      apiKey: "gsk-test-key",
      model: "llama-3.3-70b",
    };
    const result = await languageModelFor(choice, lenient).doGenerate({
      prompt,
    });
    expect(text(result)).toBe("pong");
    expect(server.seen[0]?.path).toBe("/openai/v1/chat/completions");
    expect(server.seen[0]?.headers.get("authorization")).toBe(
      "Bearer gsk-test-key",
    );
    expect(server.seen[0]?.body.model).toBe("llama-3.3-70b");
  });

  test("a local server with no key still works, and is not sent a made-up credential it cares about", async () => {
    const server = serve(() => chatReply);
    const choice: ModelChoice = {
      providerId: "ollama",
      protocol: "openai",
      baseUrl: `${server.url}/v1`,
      apiKey: null,
      model: "qwen3:8b",
    };
    const result = await languageModelFor(choice, lenient).doGenerate({
      prompt,
    });
    expect(text(result)).toBe("pong");
    expect(server.seen[0]?.path).toBe("/v1/chat/completions");
  });

  test("talks to Anthropic in its own dialect, with the version added to a bare address", async () => {
    const server = serve(() => messagesReply);
    const choice: ModelChoice = {
      providerId: "anthropic",
      protocol: "anthropic",
      baseUrl: server.url,
      apiKey: "sk-ant-test",
      model: "claude-haiku-4-5-20251001",
    };
    const result = await languageModelFor(choice, lenient).doGenerate({
      prompt,
    });
    expect(text(result)).toBe("pong");
    expect(server.seen[0]?.path).toBe("/v1/messages");
    expect(server.seen[0]?.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(server.seen[0]?.headers.get("authorization")).toBeNull();
    expect(server.seen[0]?.body.model).toBe("claude-haiku-4-5-20251001");
  });

  test("every request goes through the guarded fetch, so an address is checked when it is used", async () => {
    const server = serve(() => chatReply);
    const choice: ModelChoice = {
      providerId: "openai-compatible",
      protocol: "openai",
      baseUrl: `${server.url}/v1`,
      apiKey: null,
      model: "m",
    };
    const calls: string[] = [];
    const spy = async (url: string, init?: RequestInit) => {
      calls.push(url);
      return lenient(url, init);
    };
    await languageModelFor(choice, spy).doGenerate({ prompt });
    expect(calls).toEqual([`${server.url}/v1/chat/completions`]);
  });

  test("an address the deployment will not contact fails the run rather than being dialled", async () => {
    const server = serve(() => chatReply);
    const choice: ModelChoice = {
      providerId: "openai-compatible",
      protocol: "openai",
      baseUrl: `${server.url}/v1`,
      apiKey: null,
      model: "m",
    };
    const strict = createAgentFetch({ allowPrivateHosts: false });
    await expect(
      languageModelFor(choice, strict).doGenerate({ prompt }),
    ).rejects.toThrow();
    expect(server.seen).toHaveLength(0);
  });
});
