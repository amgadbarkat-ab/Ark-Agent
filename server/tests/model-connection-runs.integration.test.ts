import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createAgentFetch } from "../src/agents/endpoint";
import { resolveRuntimeAgents, withPersonalModels } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, modelConnections, users } from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import { createModelForActor } from "../src/models/for-actor";
import { languageModelFor } from "../src/models/language-model";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 3).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const lenient = createAgentFetch({ allowPrivateHosts: true });
const deploymentModel = {
  provider: "openai" as const,
  defaultModel: "deployment-model",
};
const made: string[] = [];

async function person() {
  const id = `runs-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}
afterEach(async () => {
  for (const id of made.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  await database.$client.close();
});

/** A recording front for the mock model server, so the test sees what really crossed the wire. */
async function withProvider<T>(
  run: (provider: {
    url: string;
    mock: LLMock;
    seen: Array<{
      path: string;
      authorization: string | null;
      apiKey: string | null;
      model: unknown;
      body: string;
    }>;
  }) => Promise<T>,
) {
  const mock = new LLMock();
  const seen: Array<{
    path: string;
    authorization: string | null;
    apiKey: string | null;
    model: unknown;
    body: string;
  }> = [];
  const base = await mock.start();
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.text();
      seen.push({
        path,
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        model: (JSON.parse(body) as { model?: unknown }).model,
        body,
      });
      return fetch(`${base}${path}`, {
        method: "POST",
        headers: request.headers,
        body,
      });
    },
  });
  try {
    return await run({ url: `http://127.0.0.1:${proxy.port}`, mock, seen });
  } finally {
    await proxy.stop(true);
    await mock.stop();
  }
}

const balanceTool = (executed: unknown[]) => async () => [
  {
    name: "read_balance",
    ref: "bank/read_balance",
    description: "Read the balance.",
    parameters: z.object({ account: z.string() }),
    execute: async (args: unknown) => {
      executed.push(args);
      return "42";
    },
  },
];

async function ask(
  model: Parameters<typeof resolveRuntimeAgents>[1],
  executed: unknown[],
  botId = "assistant",
) {
  const built = await resolveRuntimeAgents(
    async () =>
      ["assistant", "analyst"].map((id) => ({
        id,
        name: id,
        type: "built_in" as const,
        systemPrompt: "Answer using the granted balance tool.",
      })),
    model,
    // The deployment has no key at all: only the person's own connection can answer.
    async () => null,
    undefined,
    balanceTool(executed),
  );
  const agent = built[botId]?.clone();
  if (!agent) throw new Error("agent was not built");
  agent.addMessage({ id: "q", role: "user", content: "Read my balance." });
  await agent.runAgent();
  return agent.messages.at(-1);
}

describe("a run on the person's own connection", () => {
  test("an OpenAI-compatible provider answers with the person's key and model, tools included", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.on({ hasToolResult: true }, { content: "The balance is 42." });
      mock.onMessage(/balance/, {
        toolCalls: [
          { id: "c1", name: "read_balance", arguments: { account: "demo" } },
        ],
      });
      const executed: unknown[] = [];
      const connection = languageModelFor(
        {
          providerId: "groq",
          protocol: "openai",
          baseUrl: `${url}/v1`,
          apiKey: "persons-own-key",
          model: "llama-their-choice",
        },
        lenient,
      );
      const reply = await ask({ ...deploymentModel, connection }, executed);
      expect(reply).toMatchObject({
        role: "assistant",
        content: "The balance is 42.",
      });
      expect(executed).toEqual([{ account: "demo" }]);
      expect(seen.map((s) => s.path)).toEqual([
        "/v1/chat/completions",
        "/v1/chat/completions",
      ]);
      expect(
        seen.every((s) => s.authorization === "Bearer persons-own-key"),
      ).toBe(true);
      expect(seen.every((s) => s.model === "llama-their-choice")).toBe(true);
    });
  });

  test("Anthropic answers with the person's key, in its own dialect, tools included", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.on({ hasToolResult: true }, { content: "The balance is 42." });
      mock.onMessage(/balance/, {
        toolCalls: [
          { id: "c1", name: "read_balance", arguments: { account: "demo" } },
        ],
      });
      const executed: unknown[] = [];
      const connection = languageModelFor(
        {
          providerId: "anthropic",
          protocol: "anthropic",
          baseUrl: url,
          apiKey: "sk-ant-persons-own",
          model: "claude-haiku-4-5-20251001",
        },
        lenient,
      );
      const reply = await ask({ ...deploymentModel, connection }, executed);
      expect(reply).toMatchObject({
        role: "assistant",
        content: "The balance is 42.",
      });
      expect(executed).toEqual([{ account: "demo" }]);
      expect(seen.every((s) => s.path === "/v1/messages")).toBe(true);
      expect(seen.every((s) => s.apiKey === "sk-ant-persons-own")).toBe(true);
      expect(seen.every((s) => s.authorization === null)).toBe(true);
    });
  });

  test("without a connection, and without a deployment key, the run still fails as it always did", async () => {
    const executed: unknown[] = [];
    await expect(ask(deploymentModel, executed)).rejects.toThrow(
      /credential is not configured/i,
    );
  });
});

describe("the deployment's own model on a server that is not OpenAI", () => {
  /*
   * The desktop's model on this computer is llama.cpp, named by OPENAI_BASE_URL. Handed to the
   * runtime as `openai/<model>`, it was driven through the Responses API, whose llama.cpp stream the
   * SDK cannot read: every built-in employee's chat failed. It goes to chat completions now.
   */
  test("a built-in employee is answered through chat completions, with the deployment's key", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.on({ hasToolResult: true }, { content: "The balance is 42." });
      mock.onMessage(/balance/, {
        toolCalls: [
          { id: "c1", name: "read_balance", arguments: { account: "demo" } },
        ],
      });
      const previous = {
        base: process.env.OPENAI_BASE_URL,
        key: process.env.OPENAI_API_KEY,
      };
      process.env.OPENAI_BASE_URL = `${url}/v1`;
      process.env.OPENAI_API_KEY = "local-model-key";
      try {
        const executed: unknown[] = [];
        const built = await resolveRuntimeAgents(
          async () => [
            {
              id: "assistant",
              name: "assistant",
              type: "built_in" as const,
              systemPrompt: "Answer using the granted balance tool.",
            },
          ],
          deploymentModel,
          async () => "local-model-key",
          undefined,
          balanceTool(executed),
        );
        const agent = built.assistant?.clone();
        if (!agent) throw new Error("agent was not built");
        agent.addMessage({
          id: "q",
          role: "user",
          content: "Read my balance.",
        });
        await agent.runAgent();
        expect(agent.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: "The balance is 42.",
        });
        expect(executed).toEqual([{ account: "demo" }]);
        expect(seen.map((s) => s.path)).toEqual([
          "/v1/chat/completions",
          "/v1/chat/completions",
        ]);
        expect(seen.every((s) => s.model === "deployment-model")).toBe(true);
        expect(
          seen.every((s) => s.authorization === "Bearer local-model-key"),
        ).toBe(true);
      } finally {
        if (previous.base === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = previous.base;
        if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous.key;
      }
    });
  });

  /*
   * The desktop's local model has a 16K window, and a built-in employee's "hi" was a 22K-token
   * request: the browser's screen kit (the A2UI catalog above all) and every tool, sent whole. The
   * DT Lab's v0.1.14 run failed every employee chat that way.
   */
  describe("with the window of the model on this computer", () => {
    const catalog = "CATALOG-".repeat(6_000);
    const screen = {
      context: [
        { description: "The page open", value: "Expenses" },
        {
          description:
            "A2UI catalog capabilities: available catalog IDs and custom component definitions the client can render.",
          value: catalog,
        },
      ],
      tools: [
        {
          name: "render_a2ui",
          description: "Render a surface.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "showBarChart",
          description: "Show a bar chart. ".repeat(400),
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const runOn = async (
      model: Parameters<typeof resolveRuntimeAgents>[1],
      url: string,
    ) => {
      const previous = {
        base: process.env.OPENAI_BASE_URL,
        key: process.env.OPENAI_API_KEY,
        window: process.env.BOT_CONTEXT_TOKENS,
      };
      process.env.OPENAI_BASE_URL = `${url}/v1`;
      process.env.OPENAI_API_KEY = "local-model-key";
      process.env.BOT_CONTEXT_TOKENS = "16384";
      try {
        const built = await resolveRuntimeAgents(
          async () => [
            {
              id: "assistant",
              name: "assistant",
              type: "built_in" as const,
              systemPrompt: "Answer using the granted balance tool.",
            },
          ],
          model,
          async () => "local-model-key",
          undefined,
          balanceTool([]),
        );
        const agent = built.assistant?.clone();
        if (!agent) throw new Error("agent was not built");
        agent.addMessage({ id: "q", role: "user", content: "hi" });
        await agent.runAgent(screen);
      } finally {
        for (const [key, value] of [
          ["OPENAI_BASE_URL", previous.base],
          ["OPENAI_API_KEY", previous.key],
          ["BOT_CONTEXT_TOKENS", previous.window],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };
    const sent = (body: string) =>
      JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };

    test("a built-in employee's run is fitted to it: no screen kit, its own tools kept", async () => {
      await withProvider(async ({ url, mock, seen }) => {
        mock.onMessage(/hi/, { content: "Hello." });
        await runOn(deploymentModel, url);
        expect(seen).toHaveLength(1);
        const request = sent(seen[0]?.body ?? "{}");
        const system = String(request.messages[0]?.content ?? "");
        const tools = (request.tools ?? []).map((tool) => tool.function.name);
        expect(system).not.toContain("CATALOG-");
        expect(system).toContain("Expenses");
        expect(tools).toContain("read_balance");
        expect(tools).not.toContain("render_a2ui");
        // Small enough to stay once the screen kit is out of the way.
        expect(tools).toContain("showBarChart");
        expect((seen[0]?.body.length ?? 0) < 16_384 * 3).toBe(true);
      });
    });

    test("a model the person connected themselves is sent everything, as before", async () => {
      await withProvider(async ({ url, mock, seen }) => {
        mock.onMessage(/hi/, { content: "Hello." });
        const connection = languageModelFor(
          {
            providerId: "groq",
            protocol: "openai",
            baseUrl: `${url}/v1`,
            apiKey: "persons-own-key",
            model: "llama-their-choice",
          },
          lenient,
        );
        await runOn({ ...deploymentModel, connection }, url);
        const request = sent(seen[0]?.body ?? "{}");
        const tools = (request.tools ?? []).map((tool) => tool.function.name);
        expect(String(request.messages[0]?.content)).toContain("CATALOG-");
        expect(tools).toContain("render_a2ui");
        expect(tools).toContain("showBarChart");
      });
    });
  });

  /*
   * The DT Lab's lead (v0.1.14) called team_ask and was refused with "asking a colleague works from a
   * conversation": a built-in employee's team tools were built per request, before there was a run to
   * ask as. The run's own copy has to be the one that executes.
   */
  test("a team tool built for the run replaces the request's copy, so asking a colleague knows the run", async () => {
    await withProvider(async ({ url, mock }) => {
      mock.on({ hasToolResult: true }, { content: "I have asked them." });
      mock.onMessage(/colleague/, {
        toolCalls: [
          {
            id: "c1",
            name: "team_ask",
            arguments: { colleague: "Research Analyst", task: "List risks." },
          },
        ],
      });
      const used: string[] = [];
      const teamAsk = (which: "request" | "run") => ({
        name: "team_ask",
        ref: "team/ask",
        description: "Ask a colleague for work.",
        parameters: z.object({ colleague: z.string(), task: z.string() }),
        execute: async () => {
          used.push(which);
          return which === "run" ? "Handed over." : "Refused. No run.";
        },
      });
      const previous = {
        base: process.env.OPENAI_BASE_URL,
        key: process.env.OPENAI_API_KEY,
      };
      process.env.OPENAI_BASE_URL = `${url}/v1`;
      process.env.OPENAI_API_KEY = "local-model-key";
      try {
        const built = await resolveRuntimeAgents(
          async () => [
            {
              id: "lead",
              name: "lead",
              type: "built_in" as const,
              systemPrompt: "Lead the team.",
            },
          ],
          deploymentModel,
          async () => "local-model-key",
          undefined,
          async () => [teamAsk("request")],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          async () => [teamAsk("run")],
        );
        const agent = built.lead?.clone();
        if (!agent) throw new Error("agent was not built");
        agent.addMessage({
          id: "q",
          role: "user",
          content: "Ask your colleague for the risks.",
        });
        await agent.runAgent();
        expect(used).toEqual(["run"]);
      } finally {
        if (previous.base === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = previous.base;
        if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous.key;
      }
    });
  });

  test("OpenAI itself, and a deployment with no base URL, keep the runtime's own route", async () => {
    const { deploymentChatModel } = await import(
      "../src/models/language-model"
    );
    expect(deploymentChatModel("openai", "gpt-5.5", {})).toBeUndefined();
    expect(
      deploymentChatModel("openai", "gpt-5.5", {
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      }),
    ).toBeUndefined();
    expect(
      deploymentChatModel("anthropic", "claude", {
        OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      }),
    ).toBeUndefined();
    expect(
      deploymentChatModel("openai", "gemma", {
        OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      }),
    ).toBeDefined();
  });
});

describe("createModelForActor", () => {
  test("answers nothing for a person who has chosen nothing, so the deployment's model stands", async () => {
    const ann = await person();
    expect(await createModelForActor(store, lenient)(ann)).toBeUndefined();
  });

  test("builds the model from the person's default connection, and each person gets their own", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.on({ hasToolResult: true }, { content: "ok" });
      mock.onMessage(/balance/, { content: "ok" });
      const ann = await person();
      const bob = await person();
      for (const [who, key, model] of [
        [ann, "ann-key", "ann-model"],
        [bob, "bob-key", "bob-model"],
      ] as const) {
        await store.create(who, {
          providerId: "openai-compatible",
          label: "mine",
          baseUrl: `${url}/v1`,
          apiKey: key,
          model,
        });
      }
      const forActor = createModelForActor(store, lenient);
      for (const who of [ann, bob]) {
        const personal = await forActor(who);
        expect(personal?.connection).toBeDefined();
        await ask(withPersonalModels(deploymentModel, personal), []);
      }
      const byModel = new Map(seen.map((s) => [s.model, s.authorization]));
      expect(byModel.get("ann-model")).toBe("Bearer ann-key");
      expect(byModel.get("bob-model")).toBe("Bearer bob-key");
    });
  });

  test("a Bot the person pointed elsewhere thinks with that connection, every other Bot with their default", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.on({ hasToolResult: true }, { content: "ok" });
      mock.onMessage(/balance/, { content: "ok" });
      const ann = await person();
      const first = await store.create(ann, {
        providerId: "openai-compatible",
        label: "default one",
        baseUrl: `${url}/v1`,
        apiKey: "default-key",
        model: "default-model",
      });
      const second = await store.create(ann, {
        providerId: "openai-compatible",
        label: "analyst one",
        baseUrl: `${url}/v1`,
        apiKey: "analyst-key",
        model: "analyst-model",
      });
      expect(first.isDefault).toBe(true);
      await database
        .insert(agents)
        .values({
          id: "analyst",
          name: "analyst",
          type: "built_in",
          configuration: {},
        })
        .onConflictDoNothing();
      expect(await store.setChoice(ann, "analyst", second.id)).toBe(true);

      const personal = await createModelForActor(store, lenient)(ann);
      const model = withPersonalModels(deploymentModel, personal);
      await ask(model, [], "assistant");
      await ask(model, [], "analyst");

      const byModel = new Map(seen.map((s) => [s.model, s.authorization]));
      expect(byModel.get("default-model")).toBe("Bearer default-key");
      expect(byModel.get("analyst-model")).toBe("Bearer analyst-key");
      expect(seen.map((s) => s.model)).toEqual(
        expect.arrayContaining(["default-model", "analyst-model"]),
      );
    });
  });

  test("a connection that cannot be opened fails with a sentence, not a quiet fallback to the deployment's model", async () => {
    const ann = await person();
    const made = await store.create(ann, {
      providerId: "anthropic",
      label: "Claude",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-x",
      model: "m",
    });
    expect(made.hasKey).toBe(true);
    const wrongKey = createModelConnectionStore(
      database,
      Buffer.alloc(32, 8).toString("base64"),
    );
    const forActor = createModelForActor(wrongKey, lenient);
    await expect(forActor(ann)).rejects.toThrow(
      /could not be opened.*Settings/is,
    );
  });

  test("a connection chosen for a Bot that cannot be opened fails, even when the default is fine", async () => {
    const ann = await person();
    const plain = await store.create(ann, {
      providerId: "openai-compatible",
      label: "plain",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
    });
    const keyed = await store.create(ann, {
      providerId: "anthropic",
      label: "Claude",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-x",
      model: "m",
    });
    expect(plain.isDefault).toBe(true);
    await database
      .insert(agents)
      .values({
        id: "analyst",
        name: "analyst",
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
    await store.setChoice(ann, "analyst", keyed.id);
    const wrongKey = createModelConnectionStore(
      database,
      Buffer.alloc(32, 9).toString("base64"),
    );
    await expect(createModelForActor(wrongKey, lenient)(ann)).rejects.toThrow(
      /could not be opened/i,
    );
  });

  test("a connection to a provider that has since become unavailable says so", async () => {
    const ann = await person();
    await database.insert(modelConnections).values({
      userId: ann,
      providerId: "retired-provider",
      label: "Old one",
      baseUrl: "https://example.com/v1",
      model: "m",
      isDefault: true,
    });
    await expect(createModelForActor(store, lenient)(ann)).rejects.toThrow(
      /Old one.*no longer available/s,
    );
  });
});
