import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentFetch } from "../src/agents/endpoint";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import { modelGatewayRoutes } from "../src/models/gateway";
import { mintModelGrant } from "../src/models/grant";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 4).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const made: string[] = [];
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

async function person() {
  const id = `gateway-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}

type Seen = {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: string;
};

/** A provider that records each request and answers as told. */
function upstream(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        body: await request.text(),
      });
      return respond(request);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

function gateway(allowPrivateHosts = true) {
  return new Hono().route(
    "/api/model-gateway",
    modelGatewayRoutes({
      store,
      encryptionKey: KEY,
      fetchImpl: createAgentFetch({ allowPrivateHosts }),
    }),
  );
}

const call = (
  app: Hono,
  path: string,
  init: RequestInit & { token?: string; header?: "bearer" | "x-api-key" } = {},
) => {
  const { token, header = "bearer", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) {
    if (header === "bearer") headers.set("authorization", `Bearer ${token}`);
    else headers.set("x-api-key", token);
  }
  return app.request(`/api/model-gateway${path}`, { ...rest, headers });
};

afterEach(async () => {
  for (const id of made.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  for (const server of servers) server.stop(true);
  await database.$client.close();
});

const chatBody = JSON.stringify({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
});

async function connected(
  who: string,
  over: Partial<Parameters<typeof store.create>[1]> = {},
) {
  return store.create(who, {
    providerId: "openai-compatible",
    label: "mine",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "m",
    apiKey: "the-real-key",
    ...over,
  });
}

describe("the model gateway, OpenAI dialect", () => {
  test("forwards the request with the person's real key in place of the grant", async () => {
    const provider = upstream(() => Response.json({ ok: true }));
    const ann = await person();
    const connection = await connected(ann, {
      baseUrl: `${provider.url}/openai/v1`,
    });
    const grant = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );

    const response = await call(gateway(), "/openai/v1/chat/completions?x=1", {
      method: "POST",
      token: grant,
      headers: { "content-type": "application/json", cookie: "session=secret" },
      body: chatBody,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const seen = provider.seen[0] as Seen;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/openai/v1/chat/completions");
    expect(seen.search).toBe("?x=1");
    expect(seen.body).toBe(chatBody);
    expect(seen.headers.get("authorization")).toBe("Bearer the-real-key");
    // What the bot sent never goes further than the gateway.
    expect(seen.headers.get("authorization")).not.toContain(grant);
    expect(seen.headers.get("cookie")).toBeNull();
  });

  test("streams the answer as it arrives instead of holding it back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = upstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              await gate;
              controller.enqueue(new TextEncoder().encode("data: second\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const ann = await person();
    const connection = await connected(ann, { baseUrl: `${provider.url}/v1` });
    const grant = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );

    const response = await call(gateway(), "/openai/v1/chat/completions", {
      method: "POST",
      token: grant,
      body: chatBody,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    // The first chunk is here while the provider has not finished: that is streaming.
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n");
  });

  test("passes a provider's refusal through with its status, and none of its other headers", async () => {
    const provider = upstream(
      () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: {
            "retry-after": "7",
            "set-cookie": "tracker=1",
            "content-type": "application/json",
          },
        }),
    );
    const ann = await person();
    const connection = await connected(ann, { baseUrl: `${provider.url}/v1` });
    const response = await call(gateway(), "/openai/v1/chat/completions", {
      method: "POST",
      token: mintModelGrant({ actorId: ann, connectionId: connection.id }, KEY),
      body: chatBody,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("lists models with GET, and adds no key for a server that needs none", async () => {
    const provider = upstream(() => Response.json({ data: [{ id: "a" }] }));
    const ann = await person();
    const connection = await connected(ann, {
      providerId: "ollama",
      baseUrl: `${provider.url}/v1`,
      apiKey: null,
    });
    const response = await call(gateway(), "/openai/v1/models", {
      token: mintModelGrant({ actorId: ann, connectionId: connection.id }, KEY),
    });
    expect(await response.json()).toEqual({ data: [{ id: "a" }] });
    expect(provider.seen[0]?.headers.get("authorization")).toBeNull();
  });
});

describe("the model gateway, Anthropic dialect", () => {
  test("forwards under the person's key, with a version, to /v1/messages", async () => {
    const provider = upstream(() => Response.json({ type: "message" }));
    const ann = await person();
    const connection = await connected(ann, {
      providerId: "anthropic",
      baseUrl: provider.url,
      apiKey: "sk-ant-real",
    });
    const grant = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );
    const response = await call(gateway(), "/anthropic/v1/messages", {
      method: "POST",
      token: grant,
      header: "x-api-key",
      body: JSON.stringify({ model: "m", max_tokens: 5, messages: [] }),
    });
    expect(response.status).toBe(200);
    const seen = provider.seen[0] as Seen;
    expect(seen.path).toBe("/v1/messages");
    expect(seen.headers.get("x-api-key")).toBe("sk-ant-real");
    expect(seen.headers.get("anthropic-version")).toBeTruthy();
    expect(seen.headers.get("authorization")).toBeNull();
  });

  test("a connection speaking one dialect is refused on the other's route", async () => {
    const ann = await person();
    const connection = await connected(ann, {
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-real",
    });
    const response = await call(gateway(), "/openai/v1/chat/completions", {
      method: "POST",
      token: mintModelGrant({ actorId: ann, connectionId: connection.id }, KEY),
      body: chatBody,
    });
    expect(response.status).toBe(400);
  });
});

describe("who and what the gateway will serve", () => {
  test("refuses a missing, forged or expired grant", async () => {
    const ann = await person();
    const connection = await connected(ann);
    const good = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
      0,
    );
    const forged = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      Buffer.alloc(32, 9).toString("base64"),
    );
    for (const token of [
      undefined,
      "garbage",
      forged,
      good /* minted long ago */,
    ]) {
      const response = await call(gateway(), "/openai/v1/chat/completions", {
        method: "POST",
        ...(token ? { token } : {}),
        body: chatBody,
      });
      expect(response.status).toBe(401);
    }
  });

  test("a deleted connection stops working at once, even with a grant still in date", async () => {
    const provider = upstream(() => Response.json({ ok: true }));
    const ann = await person();
    const connection = await connected(ann, { baseUrl: `${provider.url}/v1` });
    const grant = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );
    const ask = () =>
      call(gateway(), "/openai/v1/chat/completions", {
        method: "POST",
        token: grant,
        body: chatBody,
      });
    expect((await ask()).status).toBe(200);
    await store.remove(ann, connection.id);
    expect((await ask()).status).toBe(401);
    expect(provider.seen).toHaveLength(1);
  });

  test("a changed key is used on the very next call", async () => {
    const provider = upstream(() => Response.json({ ok: true }));
    const ann = await person();
    const connection = await connected(ann, {
      baseUrl: `${provider.url}/v1`,
      apiKey: "old-key",
    });
    const grant = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );
    const ask = () =>
      call(gateway(), "/openai/v1/chat/completions", {
        method: "POST",
        token: grant,
        body: chatBody,
      });
    await ask();
    await store.update(ann, connection.id, { apiKey: "new-key" });
    await ask();
    expect(provider.seen.map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer old-key",
      "Bearer new-key",
    ]);
  });

  test("a grant cannot reach somebody else's connection", async () => {
    const provider = upstream(() => Response.json({ ok: true }));
    const ann = await person();
    const bob = await person();
    const annsConnection = await connected(ann, {
      baseUrl: `${provider.url}/v1`,
    });
    const response = await call(gateway(), "/openai/v1/chat/completions", {
      method: "POST",
      token: mintModelGrant(
        { actorId: bob, connectionId: annsConnection.id },
        KEY,
      ),
      body: chatBody,
    });
    expect(response.status).toBe(401);
    expect(provider.seen).toHaveLength(0);
  });

  test("serves only the model endpoints, with the methods they use", async () => {
    const provider = upstream(() => Response.json({ ok: true }));
    const ann = await person();
    const connection = await connected(ann, { baseUrl: `${provider.url}/v1` });
    const token = mintModelGrant(
      { actorId: ann, connectionId: connection.id },
      KEY,
    );
    const attempts: Array<[string, string]> = [
      ["POST", "/openai/v1/files"],
      ["DELETE", "/openai/v1/models/some-model"],
      ["GET", "/openai/v1/chat/completions"],
      ["POST", "/openai/v1/../../admin"],
      ["POST", "/openai/v1/chat/completions/../../files"],
    ];
    for (const [method, path] of attempts) {
      const response = await call(gateway(), path, {
        method,
        token,
        body: method === "POST" ? "{}" : undefined,
      });
      expect(response.status).toBe(404);
    }
    expect(provider.seen).toHaveLength(0);
  });

  test("on a hosted deployment, an address that has become private is refused rather than dialled", async () => {
    const provider = upstream(() => Response.json({ ok: true }));
    const ann = await person();
    const connection = await connected(ann, { baseUrl: `${provider.url}/v1` });
    const response = await call(gateway(false), "/openai/v1/chat/completions", {
      method: "POST",
      token: mintModelGrant({ actorId: ann, connectionId: connection.id }, KEY),
      body: chatBody,
    });
    expect(response.status).toBe(502);
    expect(provider.seen).toHaveLength(0);
  });

  test("never puts a key in anything it says", async () => {
    const ann = await person();
    const connection = await connected(ann, {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "sk-must-not-leak",
    });
    const response = await call(gateway(), "/openai/v1/chat/completions", {
      method: "POST",
      token: mintModelGrant({ actorId: ann, connectionId: connection.id }, KEY),
      body: chatBody,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("sk-must-not-leak");
  });
});
