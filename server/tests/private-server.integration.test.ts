import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "../src/db/client";
import {
  activationState,
  modelConnections,
  trialState,
  users,
} from "../src/db/schema";
import { createModelConnectionStore } from "../src/models/connections";
import { privateServerRoutes } from "../src/private-server/routes";
import {
  createPrivateServerService,
  PRIVATE_SERVER_PROVIDER,
  readServersAnswer,
} from "../src/private-server/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Ark Private Server (#149, 19 Nov) in the app: what it sends BlackArk, what it shows, and how the
 * ready server becomes the person's model connection, with its key never in an answer.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const KEY = Buffer.alloc(32, 7).toString("base64");
const connections = createModelConnectionStore(database, KEY);
const userId = `user_server_${randomUUID().slice(0, 8)}`;
const INSTALL = "5c6d7e8f-0000-4000-8000-0000000000c1";

const TIERS = [
  {
    id: "small",
    name: "Ark Private Server — Small",
    cpu: "4 vCPU",
    memory: "8 GB RAM",
    gpu: null,
    storage: "100 GB",
    modelSize: "3B",
    models: ["Llama 3.2 3B", "Qwen 2.5 3B"],
    monthlyCents: 950,
    activationCents: 0,
  },
  {
    id: "gpu_entry",
    name: "Ark Private Server — GPU Entry",
    cpu: null,
    memory: "64 GB RAM",
    gpu: "24 GB GPU",
    storage: "~1 TB NVMe",
    modelSize: "14–32B",
    models: [],
    monthlyCents: 35700,
    activationCents: 34800,
  },
];
const BUY = "https://blackark.uk/checkin/buy/?customer=demo-shop&server=";
const READY = {
  tier: "gpu_entry",
  status: "ready",
  orderedAt: "2026-11-19T16:00:00+00:00",
  paidUntil: "2026-12-19T16:00:00+00:00",
  readyAt: "2026-11-20T09:00:00+00:00",
  baseUrl: "https://srv-1.example/v1",
  model: "qwen2.5:32b",
  apiKey: "sk-test-0123456789abcdef",
};

async function clear() {
  await database
    .delete(modelConnections)
    .where(eq(modelConnections.userId, userId));
  await database.delete(activationState);
  await database.delete(trialState);
}
beforeEach(async () => {
  await clear();
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.com` })
    .onConflictDoNothing();
});
afterAll(async () => {
  await clear();
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

async function activate() {
  await database.insert(activationState).values({
    id: "install",
    kind: "license",
    customerId: "demo-shop",
    installId: INSTALL,
    payload: "payload-of-the-licence-key",
    signature: "signature-of-the-licence-key",
    nonce: "nonce-of-the-licence-key",
    planId: "team",
    validUntil: new Date("2026-12-31T00:00:00Z"),
    issuedAt: new Date("2026-11-19T00:00:00Z"),
  } as typeof activationState.$inferInsert);
}

function harness(order: unknown) {
  const sent: Record<string, unknown>[] = [];
  let answer: { status: number; body: unknown } = {
    status: 200,
    body: { tiers: TIERS, order, buyUrl: BUY },
  };
  let clock = 0;
  const service = createPrivateServerService(database, {
    connections,
    version: "0.1.51",
    url: "https://blackark.example/checkin/servers/",
    now: () => clock,
    send: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
      });
    }) as unknown as typeof fetch,
  });
  const app = new Hono<{
    Variables: { actor: { id: string; role: string } };
  }>();
  app.use("*", async (context, next) => {
    context.set("actor", {
      id: userId,
      role: context.req.header("x-role") ?? "admin",
    });
    await next();
  });
  app.route(
    "/api/private-server",
    privateServerRoutes(async (_context, next) => next(), service) as never,
  );
  return {
    sent,
    service,
    app,
    set: (next: typeof answer) => {
      answer = next;
    },
    later: (ms: number) => {
      clock += ms;
    },
  };
}

describe("Ark Private Server in the app", () => {
  test("before activation nothing is sent, and the card says it cannot ask yet", async () => {
    const h = harness(null);
    const view = await h.service.view(userId);
    expect(view).toMatchObject({ available: false, tiers: [], order: null });
    expect(h.sent).toEqual([]);
  });

  test("it sends BlackArk the install's own proof and nothing else, and shows the tiers", async () => {
    await activate();
    const h = harness(null);
    const view = await h.service.view(userId);
    expect(h.sent).toEqual([
      {
        customerId: "demo-shop",
        installId: INSTALL,
        version: "0.1.51",
        proof: {
          kind: "code",
          payload: "payload-of-the-licence-key",
          signature: "signature-of-the-licence-key",
        },
      },
    ]);
    expect(
      view.tiers.map((t) => [t.id, t.monthlyCents, t.activationCents]),
    ).toEqual([
      ["small", 950, 0],
      ["gpu_entry", 35700, 34800],
    ]);
    expect(view.buyUrl).toBe(BUY);
    expect(view.order).toBeNull();
    // Asked again within a minute: the same answer, not a second request.
    await h.service.view(userId);
    expect(h.sent).toHaveLength(1);
  });

  test("an order being set up shows as such, and cannot be connected yet", async () => {
    await activate();
    const h = harness({
      ...READY,
      status: "setting_up",
      baseUrl: null,
      model: null,
      apiKey: null,
      readyAt: null,
    });
    const view = await h.service.view(userId);
    expect(view.order).toMatchObject({
      tier: "gpu_entry",
      status: "setting_up",
      baseUrl: null,
    });
    const response = await h.app.request("/api/private-server/connect", {
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Your private server is not ready yet. BlackArk is setting it up.",
    });
  });

  test("a ready server becomes the person's default connection, and its key is never in an answer", async () => {
    await activate();
    const h = harness(READY);
    const shown = await h.app.request("/api/private-server");
    const shownText = await shown.text();
    expect(shown.status).toBe(200);
    expect(shownText).not.toContain(READY.apiKey);
    expect(JSON.parse(shownText)).toMatchObject({
      order: { status: "ready", baseUrl: READY.baseUrl, model: READY.model },
      connected: false,
    });

    const response = await h.app.request("/api/private-server/connect", {
      method: "POST",
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(READY.apiKey);
    const [connection] = await connections.list(userId);
    expect(connection).toMatchObject({
      providerId: PRIVATE_SERVER_PROVIDER,
      label: "Ark Private Server — GPU Entry",
      baseUrl: READY.baseUrl,
      model: READY.model,
      isDefault: true,
      hasKey: true,
    });
    expect((await connections.open(userId))?.apiKey).toBe(READY.apiKey);
    expect((await h.service.view(userId)).connected).toBe(true);
  });

  test("connecting again brings the same connection up to date instead of adding a second", async () => {
    await activate();
    const h = harness(READY);
    await h.service.connect(userId);
    h.set({
      status: 200,
      body: {
        tiers: TIERS,
        order: {
          ...READY,
          model: "qwen2.5:14b",
          apiKey: "sk-test-rotated-0123456789",
        },
        buyUrl: BUY,
      },
    });
    await h.service.connect(userId);
    const list = await connections.list(userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.model).toBe("qwen2.5:14b");
    expect((await connections.open(userId))?.apiKey).toBe(
      "sk-test-rotated-0123456789",
    );
  });

  test("only an administrator may see or buy it", async () => {
    await activate();
    const h = harness(READY);
    const asMember = { headers: { "x-role": "member" } };
    expect((await h.app.request("/api/private-server", asMember)).status).toBe(
      403,
    );
    expect(
      (
        await h.app.request("/api/private-server/connect", {
          method: "POST",
          ...asMember,
        })
      ).status,
    ).toBe(403);
  });

  test("BlackArk refusing or unreachable is a sentence, and the last good answer stays", async () => {
    await activate();
    const h = harness(null);
    await h.service.view(userId);
    h.later(61_000);
    h.set({ status: 502, body: {} });
    const view = await h.service.view(userId);
    expect(view.tiers).toHaveLength(2);
    expect(view.error).toBe(
      "BlackArk could not be reached. Try again in a few minutes.",
    );
  });
});

describe("reading BlackArk's answer", () => {
  test("anything malformed is refused whole", () => {
    expect(
      readServersAnswer({ tiers: TIERS, order: null, buyUrl: BUY }),
    ).not.toBeNull();
    expect(
      readServersAnswer({
        tiers: TIERS,
        order: null,
        buyUrl: "http://blackark.uk/",
      }),
    ).toBeNull();
    expect(
      readServersAnswer({
        tiers: [{ ...TIERS[0], monthlyCents: "9.50" }],
        order: null,
        buyUrl: BUY,
      }),
    ).toBeNull();
    expect(
      readServersAnswer({
        tiers: TIERS,
        order: { ...READY, status: "exploded" },
        buyUrl: BUY,
      }),
    ).toBeNull();
    // A server address that is not https is never taken.
    expect(
      readServersAnswer({
        tiers: TIERS,
        order: { ...READY, baseUrl: "http://srv-1.example/v1" },
        buyUrl: BUY,
      })?.order?.baseUrl,
    ).toBeNull();
  });
});
