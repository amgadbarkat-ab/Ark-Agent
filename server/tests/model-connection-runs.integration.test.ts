import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createAgentFetch } from "../src/agents/endpoint";
import { resolveRuntimeAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { modelConnections, users } from "../src/db/schema";
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
    }>;
  }) => Promise<T>,
) {
  const mock = new LLMock();
  const seen: Array<{
    path: string;
    authorization: string | null;
    apiKey: string | null;
    model: unknown;
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
) {
  const agents = await resolveRuntimeAgents(
    async () => [
      {
        id: "assistant",
        name: "Assistant",
        type: "built_in",
        systemPrompt: "Answer using the granted balance tool.",
      },
    ],
    model,
    // The deployment has no key at all: only the person's own connection can answer.
    async () => null,
    undefined,
    balanceTool(executed),
  );
  const agent = agents.assistant?.clone();
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
        const connection = await forActor(who);
        expect(connection).toBeDefined();
        await ask({ ...deploymentModel, connection }, []);
      }
      const byModel = new Map(seen.map((s) => [s.model, s.authorization]));
      expect(byModel.get("ann-model")).toBe("Bearer ann-key");
      expect(byModel.get("bob-model")).toBe("Bearer bob-key");
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
