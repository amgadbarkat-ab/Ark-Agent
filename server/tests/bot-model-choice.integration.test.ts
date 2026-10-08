import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { decodeModelOverride } from "../../shared/model-header";
import { createAgentFetch } from "../src/agents/endpoint";
import { createDatabase } from "../src/db/client";
import { agents, botModelChoices, users } from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import { createModelHeaderForActor } from "../src/models/for-actor";
import { modelConnectionRoutes } from "../src/models/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 4).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const people: string[] = [];
const bots: string[] = [];

async function person() {
  const id = `choice-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  people.push(id);
  return id;
}

async function bot() {
  const id = `bot-${randomUUID()}`;
  await database
    .insert(agents)
    .values({ id, name: id, type: "built_in", configuration: {} });
  bots.push(id);
  return id;
}

async function connection(who: string, label: string, model: string) {
  return store.create(who, {
    providerId: "groq",
    label,
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: `${label}-key`,
    model,
  });
}

afterEach(async () => {
  for (const id of people.splice(0))
    await database.delete(users).where(eq(users.id, id));
  if (bots.length > 0)
    await database.delete(agents).where(inArray(agents.id, bots.splice(0)));
});
afterAll(async () => {
  await database.$client.close();
});

describe("the store", () => {
  test("remembers a connection per Bot, and a person's own only", async () => {
    const ann = await person();
    const bob = await person();
    const analyst = await bot();
    const first = await connection(ann, "first", "m1");
    const second = await connection(ann, "second", "m2");
    const bobs = await connection(bob, "bobs", "m3");

    expect(await store.choices(ann)).toEqual({});
    expect(await store.setChoice(ann, analyst, second.id)).toBe(true);
    expect(await store.choices(ann)).toEqual({ [analyst]: second.id });
    expect(await store.choiceFor(ann, analyst)).toBe(second.id);
    // Changing it replaces it.
    expect(await store.setChoice(ann, analyst, first.id)).toBe(true);
    expect(await store.choiceFor(ann, analyst)).toBe(first.id);

    // Someone else's connection cannot be named, and nothing changed.
    expect(await store.setChoice(ann, analyst, bobs.id)).toBe(false);
    expect(await store.choiceFor(ann, analyst)).toBe(first.id);
    // And one person's choice is not another's.
    expect(await store.choiceFor(bob, analyst)).toBeUndefined();

    expect(await store.setChoice(ann, analyst, null)).toBe(true);
    expect(await store.choiceFor(ann, analyst)).toBeUndefined();
  });

  test("a choice goes with the connection it names, and the Bot falls back to the default", async () => {
    const ann = await person();
    const analyst = await bot();
    await connection(ann, "default", "m1");
    const other = await connection(ann, "other", "m2");
    await store.setChoice(ann, analyst, other.id);

    await store.remove(ann, other.id);

    expect(await store.choiceFor(ann, analyst)).toBeUndefined();
    const rows = await database
      .select()
      .from(botModelChoices)
      .where(eq(botModelChoices.userId, ann));
    expect(rows).toHaveLength(0);
  });
});

describe("what a managed Bot is told", () => {
  test("is the connection chosen for that Bot, and the default for every other, and never a key", async () => {
    const ann = await person();
    const analyst = await bot();
    const other = await bot();
    await connection(ann, "default", "default-model");
    const chosen = await connection(ann, "analyst", "analyst-model");
    await store.setChoice(ann, analyst, chosen.id);

    const headerFor = createModelHeaderForActor(store, KEY);
    const forAnalyst = await headerFor(ann, analyst);
    const forOther = await headerFor(ann, other);
    const withNoBot = await headerFor(ann);

    expect(decodeModelOverride(forAnalyst as string)).toMatchObject({
      model: "analyst-model",
      via: "gateway",
    });
    expect(decodeModelOverride(forOther as string)).toMatchObject({
      model: "default-model",
    });
    expect(decodeModelOverride(withNoBot as string)).toMatchObject({
      model: "default-model",
    });
    for (const header of [forAnalyst, forOther]) {
      expect(
        Buffer.from(header as string, "base64url").toString(),
      ).not.toContain("analyst-key");
    }
  });
});

describe("the routes", () => {
  function appFor(who: string, visible: string[]) {
    return new Hono().route(
      "/api/models",
      modelConnectionRoutes({
        requireUser: async (context, next) => {
          context.set("actor", {
            id: who,
            email: `${who}@example.com`,
            role: "user",
          });
          await next();
        },
        store,
        fetchImpl: createAgentFetch({ allowPrivateHosts: false }),
        allowPrivateHosts: false,
        botVisible: async (_actor, botId) => visible.includes(botId),
      }),
    );
  }
  const call = (app: Hono, method: string, path: string, body?: unknown) =>
    app.request(`/api/models${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("choose, list and clear a model for a Bot", async () => {
    const ann = await person();
    const analyst = await bot();
    const mine = await connection(ann, "mine", "m1");
    const app = appFor(ann, [analyst]);

    expect(await (await call(app, "GET", "/bots")).json()).toEqual({
      choices: [],
    });
    const set = await call(app, "PUT", `/bots/${analyst}`, {
      connectionId: mine.id,
    });
    expect(set.status).toBe(200);
    expect(await (await call(app, "GET", "/bots")).json()).toEqual({
      choices: [{ botId: analyst, connectionId: mine.id }],
    });
    const cleared = await call(app, "PUT", `/bots/${analyst}`, {
      connectionId: null,
    });
    expect(cleared.status).toBe(200);
    expect(await (await call(app, "GET", "/bots")).json()).toEqual({
      choices: [],
    });
  });

  test("refuses a Bot the person cannot see, a connection that is not theirs, and nonsense", async () => {
    const ann = await person();
    const bob = await person();
    const hidden = await bot();
    const visible = await bot();
    const mine = await connection(ann, "mine", "m1");
    const bobs = await connection(bob, "bobs", "m2");
    const app = appFor(ann, [visible]);

    const unseen = await call(app, "PUT", `/bots/${hidden}`, {
      connectionId: mine.id,
    });
    expect(unseen.status).toBe(404);
    const notMine = await call(app, "PUT", `/bots/${visible}`, {
      connectionId: bobs.id,
    });
    expect(notMine.status).toBe(404);
    for (const body of [{}, { connectionId: "not-a-uuid" }, { other: 1 }]) {
      expect((await call(app, "PUT", `/bots/${visible}`, body)).status).toBe(
        400,
      );
    }
    expect(await store.choices(ann)).toEqual({});
  });
});
