/**
 * The deployment's own bot, run as a real process, answering on a model a person chose.
 *
 * What this proves end to end: the server tells the bot which model through a grant, the bot calls
 * the server's gateway with that grant, the gateway adds the person's real key and forwards to the
 * provider, and the answer streams back. The bot is started with NO model of its own, so the only
 * way it can answer is through the person's connection.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { MODEL_HEADER } from "../../shared/model-header";
import { createAgentFetch } from "../src/agents/endpoint";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import { createModelHeaderForActor } from "../src/models/for-actor";
import { modelGatewayRoutes } from "../src/models/gateway";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 6).toString("base64");
const TOKEN = "bot-token-for-this-test";
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const made: string[] = [];
const root = join(import.meta.dir, "../..");

let gateway: ReturnType<typeof Bun.serve>;
let bot: ReturnType<typeof Bun.spawn> | undefined;
let botUrl = "";

async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  return port;
}

beforeAll(async () => {
  const app = new Hono().route(
    "/api/model-gateway",
    modelGatewayRoutes({
      store,
      encryptionKey: KEY,
      fetchImpl: createAgentFetch({ allowPrivateHosts: true }),
    }),
  );
  gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });

  const port = await freePort();
  bot = Bun.spawn(["bun", "agent-langgraph/src/index.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: String(port),
      MANAGED_AGENT_TOKEN: TOKEN,
      AGENT_TOOL_TOKEN: "unused",
      // This deployment supplies no model: only a person's own can answer.
      BOT_PROVIDER: "none",
      // How the bot reaches the server; the gateway path is resolved against it.
      OPENBOT_TOOL_URL: `http://127.0.0.1:${gateway.port}/api/agent-tools/call`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  botUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${botUrl}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
  throw new Error("the bot did not start");
});

afterEach(async () => {
  for (const id of made.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  bot?.kill();
  await gateway.stop(true);
  await database.$client.close();
});

async function person() {
  const id = `bot-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}

type Seen = {
  path: string;
  authorization: string | null;
  apiKey: string | null;
  model: unknown;
};

async function withProvider<T>(
  run: (provider: { url: string; mock: LLMock; seen: Seen[] }) => Promise<T>,
) {
  const mock = new LLMock();
  const seen: Seen[] = [];
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

async function run(headers: Record<string, string>) {
  const response = await fetch(`${botUrl}/ag-ui`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": TOKEN,
      ...headers,
    },
    body: JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "user", content: "say pong" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const text = await response.text();
  return { status: response.status, text, answer: answerIn(text) };
}

/** The reply as a client assembles it: the streamed pieces of text, joined in order. */
function answerIn(stream: string): string {
  return stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) => JSON.parse(line.slice(6)) as { type: string; delta?: string },
    )
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta ?? "")
    .join("");
}

describe("the managed bot on a person's model", () => {
  test("answers through the gateway, on the person's key and model, and never holds the key", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.onMessage(/pong/, { content: "pong from the person's model" });
      const ann = await person();
      await store.create(ann, {
        providerId: "groq",
        label: "Groq",
        baseUrl: `${url}/openai/v1`,
        apiKey: "ann-real-groq-key",
        model: "llama-ann-chose",
      });
      const header = await createModelHeaderForActor(store, KEY)(ann);
      expect(header).toBeDefined();
      // What the bot is given contains no key.
      expect(
        Buffer.from(header as string, "base64url").toString(),
      ).not.toContain("ann-real-groq-key");

      const { status, text, answer } = await run({
        [MODEL_HEADER]: header as string,
      });
      expect(status).toBe(200);
      expect(text).toContain("RUN_FINISHED");
      expect(text).not.toContain("RUN_ERROR");
      expect(answer).toBe("pong from the person's model");

      expect(seen.length).toBeGreaterThan(0);
      expect(
        seen.every((s) => s.authorization === "Bearer ann-real-groq-key"),
      ).toBe(true);
      expect(seen.every((s) => s.model === "llama-ann-chose")).toBe(true);
      expect(seen.every((s) => s.path === "/openai/v1/chat/completions")).toBe(
        true,
      );
    });
  });

  test("answers in Anthropic's dialect through the gateway too", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.onMessage(/pong/, { content: "pong from claude" });
      const ann = await person();
      await store.create(ann, {
        providerId: "anthropic",
        label: "Claude",
        baseUrl: url,
        apiKey: "sk-ant-real",
        model: "claude-haiku-4-5-20251001",
      });
      const header = await createModelHeaderForActor(store, KEY)(ann);
      const { status, text, answer } = await run({
        [MODEL_HEADER]: header as string,
      });
      expect(status).toBe(200);
      expect(answer).toBe("pong from claude");
      expect(text).not.toContain("RUN_ERROR");
      expect(seen.every((s) => s.path === "/v1/messages")).toBe(true);
      expect(seen.every((s) => s.apiKey === "sk-ant-real")).toBe(true);
    });
  });

  test("a person who removed their connection mid-conversation is told, not charged to anyone else", async () => {
    await withProvider(async ({ url, mock, seen }) => {
      mock.onMessage(/pong/, { content: "should never be reached" });
      const ann = await person();
      const connection = await store.create(ann, {
        providerId: "groq",
        label: "Groq",
        baseUrl: `${url}/openai/v1`,
        apiKey: "ann-key",
        model: "m",
      });
      const header = await createModelHeaderForActor(store, KEY)(ann);
      await store.remove(ann, connection.id);
      const { text } = await run({ [MODEL_HEADER]: header as string });
      expect(text).toContain("RUN_ERROR");
      expect(seen).toHaveLength(0);
    });
  });

  test("with no model chosen and none supplied, the run says what to do", async () => {
    const { status, text } = await run({});
    expect(status).toBe(200);
    expect(text).toContain("RUN_ERROR");
    expect(text).toMatch(/Settings.*Models/s);
  });

  test("a model selection the bot cannot read is refused rather than answered on some other model", async () => {
    for (const bad of ["garbage", Buffer.from("{}").toString("base64url")]) {
      const { status } = await run({ [MODEL_HEADER]: bad });
      expect(status).toBe(400);
    }
  });

  test("without the deployment's token the bot answers nobody", async () => {
    const response = await fetch(`${botUrl}/ag-ui`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});
