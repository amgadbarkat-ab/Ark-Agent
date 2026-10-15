/**
 * The free starter model, end to end through the pieces a person's message passes: the header that
 * tells a bot which model to use, the gateway the bot calls, and the model the server's own agents
 * build. The "server" the starter talks to is a real HTTP server on a local port.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { decodeModelOverride } from "../../shared/model-header";
import { createAgentFetch } from "../src/agents/endpoint";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import {
  createModelForActor,
  createModelHeaderForActor,
} from "../src/models/for-actor";
import { modelGatewayRoutes } from "../src/models/gateway";
import { mintModelGrant, readModelGrant } from "../src/models/grant";
import { modelConnectionRoutes } from "../src/models/routes";
import {
  createStarterModel,
  STARTER_CONNECTION_ID,
  type StarterModelConfig,
} from "../src/models/starter";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 9).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const made: string[] = [];
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

async function person() {
  const id = `starter-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}

type Seen = { path: string; headers: Headers; body: string };

/** The starter's server: records requests, answers as told. */
function starterServer(
  respond: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ choices: [{ message: { content: "hello" } }] }),
) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.text(),
      });
      return respond(request);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1`, seen };
}

const starterConfig = (
  baseUrl: string,
  over: Partial<StarterModelConfig> = {},
): StarterModelConfig => ({
  baseUrl,
  token: "operator-secret-token",
  model: "gemma-4-e4b",
  concurrency: 1,
  maxWaitMs: 5_000,
  ...over,
});

function gateway(starter?: ReturnType<typeof createStarterModel>) {
  return new Hono().route(
    "/api/model-gateway",
    modelGatewayRoutes({
      store,
      encryptionKey: KEY,
      fetchImpl: createAgentFetch({ allowPrivateHosts: false }),
      ...(starter ? { starter } : {}),
    }),
  );
}

const chat = (app: Hono, grant: string, path = "/openai/v1/chat/completions") =>
  app.request(`/api/model-gateway${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "x", messages: [] }),
  });

afterEach(async () => {
  for (const id of made.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  for (const server of servers) server.stop(true);
  await database.$client.close();
});

describe("the gateway, for a grant that names the starter model", () => {
  test("forwards to the operator's server with the operator's token, never the grant", async () => {
    const server = starterServer();
    const starter = createStarterModel(starterConfig(server.url));
    const ann = await person();
    const grant = mintModelGrant(
      { actorId: ann, connectionId: STARTER_CONNECTION_ID },
      KEY,
    );

    // The deployment refuses private addresses (allowPrivateHosts: false above), and this one is on
    // 127.0.0.1: the starter's address is the operator's and is not subject to that guard.
    const response = await chat(gateway(starter), grant);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      choices: [{ message: { content: "hello" } }],
    });

    const seen = server.seen[0] as Seen;
    expect(seen.path).toBe("/v1/chat/completions");
    expect(seen.headers.get("authorization")).toBe(
      "Bearer operator-secret-token",
    );
    expect(seen.headers.get("authorization")).not.toContain(grant);
  });

  test("answers 401 with a sentence when this deployment has no starter model", async () => {
    const ann = await person();
    const grant = mintModelGrant(
      { actorId: ann, connectionId: STARTER_CONNECTION_ID },
      KEY,
    );
    const response = await chat(gateway(), grant);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("starter model is not available");
  });

  test("does not speak Anthropic's dialect", async () => {
    const server = starterServer();
    const ann = await person();
    const grant = mintModelGrant(
      { actorId: ann, connectionId: STARTER_CONNECTION_ID },
      KEY,
    );
    const response = await chat(
      gateway(createStarterModel(starterConfig(server.url))),
      grant,
      "/anthropic/v1/messages",
    );
    expect(response.status).toBe(400);
    expect(server.seen).toHaveLength(0);
  });

  test("a request that waits too long is 503 with Retry-After and a sentence", async () => {
    // A server that never finishes its answer, so the one turn stays taken.
    const stuck = starterServer(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Headers go out with the first bytes; then the answer never ends.
              controller.enqueue(new TextEncoder().encode("data: start\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const starter = createStarterModel(
      starterConfig(stuck.url, { maxWaitMs: 60 }),
    );
    const app = gateway(starter);
    const ann = await person();
    const grant = mintModelGrant(
      { actorId: ann, connectionId: STARTER_CONNECTION_ID },
      KEY,
    );

    const first = await chat(app, grant); // takes the only turn and never gives it up
    expect(first.status).toBe(200);
    const second = await chat(app, grant);
    expect(second.status).toBe(503);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await second.json()) as { error: { message: string } };
    expect(body.error.message).toContain("busy right now");
    await first.body?.cancel();
    expect(starter.status().active).toBe(0);
  });

  test("says the starter is not answering when its server is down", async () => {
    const starter = createStarterModel(starterConfig("http://127.0.0.1:1/v1"));
    const ann = await person();
    const grant = mintModelGrant(
      { actorId: ann, connectionId: STARTER_CONNECTION_ID },
      KEY,
    );
    const response = await chat(gateway(starter), grant);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("starter model is not answering");
    expect(body.error.message).not.toContain("127.0.0.1");
    expect(starter.status().active).toBe(0);
  });

  test("a person's own connection still goes to their own address and key", async () => {
    const theirs = starterServer();
    const ann = await person();
    const connection = await store.create(ann, {
      providerId: "openai-compatible",
      label: "mine",
      baseUrl: theirs.url,
      model: "m",
      apiKey: "their-own-key",
    });
    const grant = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );
    const operator = starterServer();
    const app = new Hono().route(
      "/api/model-gateway",
      modelGatewayRoutes({
        store,
        encryptionKey: KEY,
        fetchImpl: createAgentFetch({ allowPrivateHosts: true }),
        starter: createStarterModel(starterConfig(operator.url)),
      }),
    );
    const response = await chat(app, grant);
    expect(response.status).toBe(200);
    expect(theirs.seen).toHaveLength(1);
    expect(theirs.seen[0]?.headers.get("authorization")).toBe(
      "Bearer their-own-key",
    );
    expect(operator.seen).toHaveLength(0);
  });
});

describe("which model a person's bot is told to use", () => {
  const starter = createStarterModel(
    starterConfig("https://starter.example/v1"),
  );

  test("with nothing of their own and a starter model, a grant that names the starter", async () => {
    const ann = await person();
    const header = await createModelHeaderForActor(store, KEY, starter)(ann);
    const override = decodeModelOverride(header);
    expect(override).toMatchObject({
      protocol: "openai",
      baseUrl: "/api/model-gateway/openai/v1",
      model: "gemma-4-e4b",
      via: "gateway",
    });
    // The bot is handed a grant, and the operator's token is nowhere in what it holds.
    expect(header).not.toContain("operator-secret-token");
    expect(JSON.stringify(override)).not.toContain("operator-secret-token");
    expect(readModelGrant(override?.apiKey, KEY)).toEqual({
      actorId: ann,
      connectionId: STARTER_CONNECTION_ID,
    });
  });

  test("with a connection of their own, theirs and never the starter", async () => {
    const ann = await person();
    const connection = await store.create(ann, {
      providerId: "openai-compatible",
      label: "mine",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "their-model",
      apiKey: "k",
    });
    const override = decodeModelOverride(
      await createModelHeaderForActor(store, KEY, starter)(ann),
    );
    expect(override?.model).toBe("their-model");
    expect(readModelGrant(override?.apiKey, KEY)?.connectionId).toBe(
      connection.id,
    );
  });

  test("with no starter model, nothing: the bot keeps the model it was started with", async () => {
    const ann = await person();
    expect(await createModelHeaderForActor(store, KEY)(ann)).toBeUndefined();
  });
});

describe("which model the server's own agents run on", () => {
  test("nothing of their own and a starter model: the starter model", async () => {
    const starter = createStarterModel(
      starterConfig("https://starter.example/v1"),
    );
    const ann = await person();
    const models = await createModelForActor(
      store,
      createAgentFetch({ allowPrivateHosts: false }),
      starter,
    )(ann);
    expect(models?.connection).toBeDefined();
    expect(models?.connection?.modelId).toBe("gemma-4-e4b");
    expect(models?.forBot.size).toBe(0);
  });

  test("nothing of their own and no starter model: nothing, so the deployment's own model answers as before", async () => {
    const ann = await person();
    const models = await createModelForActor(
      store,
      createAgentFetch({ allowPrivateHosts: false }),
    )(ann);
    expect(models).toBeUndefined();
  });

  test("their own connection wins over the starter model", async () => {
    const starter = createStarterModel(
      starterConfig("https://starter.example/v1"),
    );
    const ann = await person();
    await store.create(ann, {
      providerId: "openai-compatible",
      label: "mine",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "their-model",
      apiKey: "k",
    });
    const models = await createModelForActor(
      store,
      createAgentFetch({ allowPrivateHosts: true }),
      starter,
    )(ann);
    expect(models?.connection?.modelId).toBe("their-model");
  });

  test("a model run on the starter really reaches the operator's server, with its token", async () => {
    const server = starterServer(() =>
      Response.json({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "gemma-4-e4b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from the starter" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const starter = createStarterModel(starterConfig(server.url));
    const ann = await person();
    const models = await createModelForActor(
      store,
      createAgentFetch({ allowPrivateHosts: false }),
      starter,
    )(ann);
    const model = models?.connection;
    expect(model).toBeDefined();
    const result = await model?.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    expect(JSON.stringify(result?.content)).toContain("hello from the starter");
    expect(server.seen[0]?.path).toBe("/v1/chat/completions");
    expect(server.seen[0]?.headers.get("authorization")).toBe(
      "Bearer operator-secret-token",
    );
  });
});

describe("the status route the Models screen reads", () => {
  function routes(starter?: ReturnType<typeof createStarterModel>) {
    return new Hono().route(
      "/api/models",
      modelConnectionRoutes({
        requireUser: async (context, next) => {
          const id = context.req.header("x-test-user");
          if (!id) return context.json({ error: "Sign in" }, 401);
          context.set("actor", {
            id,
            email: `${id}@example.com`,
            role: "user",
          });
          await next();
        },
        store,
        fetchImpl: createAgentFetch({ allowPrivateHosts: false }),
        allowPrivateHosts: false,
        ...(starter ? { starter } : {}),
      }),
    );
  }
  const get = (app: Hono, signedIn = true) =>
    app.request("/api/models/starter", {
      headers: signedIn ? { "x-test-user": "someone" } : {},
    });

  test("says plainly that there is no starter model when the deployment has none", async () => {
    const response = await get(routes());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false });
  });

  test("reports whether it answers and how busy it is, and nothing of its address or token", async () => {
    const server = starterServer();
    const starter = createStarterModel(
      starterConfig(server.url, { maxWaitMs: 90_000 }),
    );
    const response = await get(routes(starter));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      configured: true,
      state: "ready",
      model: "gemma-4-e4b",
      active: 0,
      waiting: 0,
      concurrency: 1,
      maxWaitSeconds: 90,
    });
    expect(text).not.toContain("operator-secret-token");
    expect(text).not.toContain("127.0.0.1");
  });

  test("reports down when the server does not answer", async () => {
    const starter = createStarterModel(starterConfig("http://127.0.0.1:1/v1"));
    const body = (await (await get(routes(starter))).json()) as {
      state: string;
    };
    expect(body.state).toBe("down");
  });

  test("is for signed-in people only", async () => {
    expect((await get(routes(), false)).status).toBe(401);
  });
});
