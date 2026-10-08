import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentFetch } from "../src/agents/endpoint";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import {
  type ModelAuditEvent,
  modelConnectionRoutes,
} from "../src/models/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 5).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const made: string[] = [];
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

async function person() {
  const id = `routes-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}

/** A model server that records what it was asked and answers with a fixed list. */
function fakeProvider(status = 200) {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return status === 200
        ? Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] })
        : new Response("nope", { status });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

const trail: ModelAuditEvent[] = [];

function appFor(userId: string | null, options: { hosted?: boolean } = {}) {
  const allowPrivateHosts = !options.hosted;
  return new Hono().route(
    "/api/models",
    modelConnectionRoutes({
      requireUser: async (context, next) => {
        if (!userId) return context.json({ error: "Sign in" }, 401);
        context.set("actor", {
          id: userId,
          email: `${userId}@example.com`,
          role: "user",
        });
        await next();
      },
      store,
      fetchImpl: createAgentFetch({ allowPrivateHosts }),
      allowPrivateHosts,
      audit: async (event) => {
        trail.push(event);
      },
    }),
  );
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.request(`/api/models${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

afterEach(async () => {
  trail.length = 0;
  for (const id of made.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  for (const server of servers) server.stop(true);
  await database.$client.close();
});

describe("GET /providers", () => {
  test("lists every provider; local ones are usable on a laptop and refused on a hosted server", async () => {
    const ann = await person();
    const laptop = await (await call(appFor(ann), "GET", "/providers")).json();
    const hosted = await (
      await call(appFor(ann, { hosted: true }), "GET", "/providers")
    ).json();
    const ollamaOnLaptop = laptop.providers.find(
      (p: { id: string }) => p.id === "ollama",
    );
    const ollamaHosted = hosted.providers.find(
      (p: { id: string }) => p.id === "ollama",
    );
    expect(ollamaOnLaptop.unavailable).toBeUndefined();
    expect(ollamaHosted.unavailable).toMatch(/desktop app/i);
    expect(laptop.localModels.length).toBeGreaterThan(0);
    expect(
      hosted.providers.find((p: { id: string }) => p.id === "anthropic")
        .unavailable,
    ).toBeUndefined();
  });

  test("needs a signed-in person", async () => {
    expect((await call(appFor(null), "GET", "/providers")).status).toBe(401);
  });
});

describe("creating connections", () => {
  test("saves one, never returns its key, and makes the first the default", async () => {
    const ann = await person();
    const app = appFor(ann);
    const response = await call(app, "POST", "/connections", {
      providerId: "anthropic",
      apiKey: "sk-ant-never-show-this",
      model: "claude-haiku-4-5-20251001",
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain("sk-ant-never-show-this");
    const { connection } = JSON.parse(text);
    expect(connection).toMatchObject({
      providerId: "anthropic",
      label: "Anthropic (Claude)",
      baseUrl: "https://api.anthropic.com",
      hasKey: true,
      isDefault: true,
    });
    const listed = await (await call(app, "GET", "/connections")).text();
    expect(listed).not.toContain("sk-ant-never-show-this");
  });

  test("explains what is missing or not allowed, in plain words", async () => {
    const app = appFor(await person());
    const cases: Array<[unknown, number, RegExp]> = [
      [{ providerId: "anthropic", model: "m" }, 400, /needs an api key/i],
      [{ providerId: "nope", model: "m" }, 400, /not one ark knows/i],
      [{ providerId: "chatgpt-plan", model: "m" }, 400, /approval/i],
      [
        {
          providerId: "openai",
          apiKey: "k",
          model: "m",
          baseUrl: "https://evil.example/v1",
        },
        400,
        /own address/i,
      ],
      [{ providerId: "ollama" }, 400, /choose a provider and a model/i],
      [
        { providerId: "ollama", model: "m", surprise: true },
        400,
        /choose a provider and a model/i,
      ],
    ];
    for (const [body, status, message] of cases) {
      const response = await call(app, "POST", "/connections", body);
      expect(response.status).toBe(status);
      expect((await response.json()).error).toMatch(message);
    }
  });

  test("a hosted server refuses a model on someone's own computer, by name", async () => {
    const app = appFor(await person(), { hosted: true });
    const response = await call(app, "POST", "/connections", {
      providerId: "ollama",
      model: "qwen3:8b",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/desktop app/i);
  });

  test("refuses a custom address that points at the server's own network or the metadata service", async () => {
    for (const hosted of [true, false]) {
      const app = appFor(await person(), { hosted });
      const response = await call(app, "POST", "/connections", {
        providerId: "openai-compatible",
        baseUrl: "http://169.254.169.254/v1",
        model: "m",
      });
      expect(response.status).toBe(400);
    }
    const hostedApp = appFor(await person(), { hosted: true });
    const internal = await call(hostedApp, "POST", "/connections", {
      providerId: "openai-compatible",
      baseUrl: "http://10.0.0.5:8000/v1",
      model: "m",
    });
    expect(internal.status).toBe(400);
  });
});

describe("changing and removing", () => {
  async function saved(app: Hono, over: Record<string, unknown> = {}) {
    const response = await call(app, "POST", "/connections", {
      providerId: "anthropic",
      apiKey: "sk-ant-1",
      model: "m1",
      ...over,
    });
    return (await response.json()).connection as { id: string };
  }

  test("renames and re-keys, and will not strip the key a provider needs", async () => {
    const app = appFor(await person());
    const { id } = await saved(app);
    const renamed = await call(app, "PATCH", `/connections/${id}`, {
      label: "Work",
      model: "m2",
    });
    expect((await renamed.json()).connection).toMatchObject({
      label: "Work",
      model: "m2",
      hasKey: true,
    });
    const refused = await call(app, "PATCH", `/connections/${id}`, {
      apiKey: null,
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/needs an api key/i);
    const rekeyed = await call(app, "PATCH", `/connections/${id}`, {
      apiKey: "sk-ant-2",
    });
    expect(rekeyed.status).toBe(200);
    expect(await rekeyed.text()).not.toContain("sk-ant-2");
  });

  test("a key a provider does not need can be removed", async () => {
    const app = appFor(await person());
    const { id } = await saved(app, {
      providerId: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "optional-key",
    });
    const cleared = await call(app, "PATCH", `/connections/${id}`, {
      apiKey: "",
    });
    expect((await cleared.json()).connection.hasKey).toBe(false);
  });

  test("moves the default, removes, and says no to someone else's", async () => {
    const ann = await person();
    const bob = await person();
    const appA = appFor(ann);
    const appB = appFor(bob);
    const a = await saved(appA, { label: "A" });
    const b = await saved(appA, { label: "B" });

    const moved = await call(appA, "POST", `/connections/${b.id}/default`);
    expect((await moved.json()).connection).toMatchObject({
      id: b.id,
      isDefault: true,
    });

    for (const [method, path] of [
      ["PATCH", `/connections/${a.id}`],
      ["DELETE", `/connections/${a.id}`],
      ["POST", `/connections/${a.id}/default`],
      ["POST", `/connections/${a.id}/probe`],
    ] as const) {
      const body = method === "PATCH" ? { label: "x" } : undefined;
      expect((await call(appB, method, path, body)).status).toBe(404);
    }

    expect((await call(appA, "DELETE", `/connections/${b.id}`)).status).toBe(
      200,
    );
    const left = (await (await call(appA, "GET", "/connections")).json())
      .connections;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: a.id, isDefault: true });
  });
});

describe("the trail", () => {
  const SECRET = "sk-ant-SECRET-VALUE-for-the-trail";

  test("records adding, changing, defaulting and removing a connection, and never a key", async () => {
    const ann = await person();
    const app = appFor(ann);
    const { connection } = await (
      await call(app, "POST", "/connections", {
        providerId: "anthropic",
        apiKey: SECRET,
        model: "claude-haiku-4-5-20251001",
      })
    ).json();
    await call(app, "PATCH", `/connections/${connection.id}`, {
      model: "claude-sonnet-4-5",
      apiKey: `${SECRET}-2`,
    });
    await call(app, "POST", `/connections/${connection.id}/default`);
    await call(app, "DELETE", `/connections/${connection.id}`);

    expect(trail.map((event) => event.eventType)).toEqual([
      "model.connection_added",
      "model.connection_changed",
      "model.default_changed",
      "model.connection_removed",
    ]);
    for (const event of trail) {
      expect(event.actorUserId).toBe(ann);
      expect(event.targetId).toBe(connection.id);
    }
    expect(trail[0]?.payload).toMatchObject({
      providerId: "anthropic",
      host: "api.anthropic.com",
      keySet: true,
    });
    expect(trail[1]?.payload).toMatchObject({
      changed: ["apiKey", "model"],
      model: { from: "claude-haiku-4-5-20251001", to: "claude-sonnet-4-5" },
      key: "replaced",
    });
    expect(trail[3]?.payload).toMatchObject({
      providerId: "anthropic",
      host: "api.anthropic.com",
    });
    // The one thing that must never be here.
    expect(JSON.stringify(trail)).not.toContain("SECRET");
  });

  test("records removing a key, and a coworker being given a different model", async () => {
    const ann = await person();
    const app = appFor(ann);
    const { connection } = await (
      await call(app, "POST", "/connections", {
        providerId: "ollama",
        model: "llama3",
      })
    ).json();
    await call(app, "PATCH", `/connections/${connection.id}`, {
      apiKey: null,
    });
    expect(trail.at(-1)?.payload).toMatchObject({
      changed: ["apiKey"],
      key: "removed",
    });
  });

  test("a refused or failed change leaves nothing on the trail", async () => {
    const ann = await person();
    const bob = await person();
    const { connection } = await (
      await call(appFor(ann), "POST", "/connections", {
        providerId: "anthropic",
        apiKey: SECRET,
        model: "m",
      })
    ).json();
    trail.length = 0;
    // Somebody else's connection, a bad body, and a connection that is not there.
    await call(appFor(bob), "PATCH", `/connections/${connection.id}`, {
      model: "x",
    });
    await call(appFor(bob), "DELETE", `/connections/${connection.id}`);
    await call(appFor(bob), "POST", `/connections/${connection.id}/default`);
    await call(appFor(ann), "PATCH", `/connections/${connection.id}`, {
      surprise: 1,
    });
    await call(appFor(ann), "POST", "/connections", {
      providerId: "anthropic",
      model: "m",
    });
    expect(trail).toEqual([]);
  });

  test("a trail that cannot be written does not undo the change", async () => {
    const ann = await person();
    const app = new Hono().route(
      "/api/models",
      modelConnectionRoutes({
        requireUser: async (context, next) => {
          context.set("actor", {
            id: ann,
            email: `${ann}@example.com`,
            role: "user",
          });
          await next();
        },
        store,
        fetchImpl: createAgentFetch({ allowPrivateHosts: true }),
        allowPrivateHosts: true,
        audit: async () => {
          throw new Error("the log is down");
        },
      }),
    );
    const response = await call(app, "POST", "/connections", {
      providerId: "anthropic",
      apiKey: SECRET,
      model: "m",
    });
    expect(response.status).toBe(201);
    expect(
      (await (await call(app, "GET", "/connections")).json()).connections,
    ).toHaveLength(1);
  });
});

describe("testing a connection", () => {
  test("tests before saving, with the key from the form, and keeps nothing", async () => {
    const provider = fakeProvider();
    const ann = await person();
    const app = appFor(ann);
    const result = await (
      await call(app, "POST", "/probe", {
        providerId: "openai-compatible",
        baseUrl: `${provider.url}/v1`,
        apiKey: "typed-in-the-form",
      })
    ).json();
    expect(result).toEqual({ ok: true, models: ["model-a", "model-b"] });
    expect(provider.requests[0]).toEqual({
      path: "/v1/models",
      authorization: "Bearer typed-in-the-form",
    });
    expect((await store.list(ann)).length).toBe(0);
  });

  test("tests a saved connection with the key it holds", async () => {
    const provider = fakeProvider();
    const app = appFor(await person());
    const saved = await (
      await call(app, "POST", "/connections", {
        providerId: "openai-compatible",
        baseUrl: `${provider.url}/v1`,
        apiKey: "the-stored-key",
        model: "model-a",
      })
    ).json();
    const result = await (
      await call(app, "POST", `/connections/${saved.connection.id}/probe`)
    ).json();
    expect(result.ok).toBe(true);
    expect(provider.requests.at(-1)?.authorization).toBe(
      "Bearer the-stored-key",
    );
  });

  test("reports a provider that refuses the key", async () => {
    const provider = fakeProvider(401);
    const app = appFor(await person());
    const result = await (
      await call(app, "POST", "/probe", {
        providerId: "openai-compatible",
        baseUrl: provider.url,
        apiKey: "wrong",
      })
    ).json();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/refused the key/i);
  });

  test("does not let anyone use it to scan: tests are rate limited per person", async () => {
    const provider = fakeProvider();
    const app = appFor(await person());
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const response = await call(app, "POST", "/probe", {
        providerId: "openai-compatible",
        baseUrl: provider.url,
      });
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
