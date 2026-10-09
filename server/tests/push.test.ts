import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import webpush from "web-push";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";
import { isAllowedPushEndpoint } from "../src/push/endpoints";
import { pushRoutes } from "../src/push/routes";
import {
  createPushSender,
  type PushSend,
  webPushSend,
} from "../src/push/sender";
import type {
  PushStore,
  StoredSubscription,
  PushSubscriptionInput,
} from "../src/push/store";
import { createRoutineRunner } from "../src/routines/runner";

/**
 * Notifications, without a database or a push service.
 *
 * What is protected: this server only ever calls the push services browsers use, never an address a
 * person made up; a device that is gone is forgotten, one that merely failed is kept; a person can
 * only touch their own devices; and a routine ending never fails because a notification could not go.
 */

describe("which addresses it will call", () => {
  test("the push services browsers use, and nothing else", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QAbc",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(isAllowedPushEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com.example/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "ftp://fcm.googleapis.com/x",
      "not a url",
      `https://fcm.googleapis.com/${"a".repeat(2100)}`,
    ]) {
      expect(isAllowedPushEndpoint(bad)).toBe(false);
    }
  });

  test("an operator can add a service of their own, and only by name", () => {
    expect(isAllowedPushEndpoint("https://push.example.org/x")).toBe(false);
    expect(
      isAllowedPushEndpoint("https://push.example.org/x", ["push.example.org"]),
    ).toBe(true);
    expect(
      isAllowedPushEndpoint("https://push.example.org.evil.test/x", [
        "push.example.org",
      ]),
    ).toBe(false);
  });
});

describe("the key pair in the configuration", () => {
  const keys = webpush.generateVAPIDKeys();
  const load = (extra: Record<string, string>) =>
    loadConfig(
      testEnvironment({
        BETTER_AUTH_URL: "https://app.example.com",
        TRUSTED_ORIGINS: "https://app.example.com",
        ...extra,
      }),
    );

  test("none means no notifications, and nothing else changes", () => {
    expect(load({}).webPush).toBeUndefined();
  });

  test("both keys switch it on, with the app's https address as the contact", () => {
    const config = load({
      WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
    });
    expect(config.webPush).toMatchObject({
      publicKey: keys.publicKey,
      subject: "https://app.example.com",
      allowedHosts: [],
    });
  });

  test("one key alone, a key of the wrong shape, or no contact is refused at start-up", () => {
    expect(() => load({ WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey })).toThrow(
      /go together/,
    );
    expect(() =>
      load({
        WEB_PUSH_VAPID_PUBLIC_KEY: "short",
        WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
      }),
    ).toThrow(/not a push public key/);
    expect(() =>
      load({
        WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: "short",
      }),
    ).toThrow(/not a push private key/);
    expect(() =>
      load({
        WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
        TRUSTED_ORIGINS: "http://localhost:3010",
      }),
    ).toThrow(/WEB_PUSH_SUBJECT/);
    expect(
      load({
        WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
        TRUSTED_ORIGINS: "http://localhost:3010",
        WEB_PUSH_SUBJECT: "mailto:ops@example.com",
      }).webPush?.subject,
    ).toBe("mailto:ops@example.com");
  });
});

/** A store in memory, with the same rules as the real one for what these tests ask. */
function memoryStore() {
  const rows: (StoredSubscription & { userId: string })[] = [];
  const removed: string[] = [];
  const store: PushStore = {
    async save(userId: string, input: PushSubscriptionInput) {
      const at = rows.findIndex((row) => row.endpoint === input.endpoint);
      const row = { id: `id-${rows.length}`, userId, ...input };
      if (at === -1) rows.push(row);
      else rows[at] = row;
    },
    async remove(userId, endpoint) {
      const at = rows.findIndex(
        (row) => row.userId === userId && row.endpoint === endpoint,
      );
      if (at === -1) return false;
      rows.splice(at, 1);
      return true;
    },
    async removeEverywhere(endpoint) {
      removed.push(endpoint);
      const at = rows.findIndex((row) => row.endpoint === endpoint);
      if (at !== -1) rows.splice(at, 1);
    },
    async forUser(userId) {
      return rows.filter((row) => row.userId === userId);
    },
    async count(userId) {
      return rows.filter((row) => row.userId === userId).length;
    },
  };
  return { store, rows, removed };
}

const device = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  p256dh:
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
});

describe("sending", () => {
  test("every device of the person gets the message, trimmed to what a notification can hold", async () => {
    const { store } = memoryStore();
    await store.save("ann", device("a"));
    await store.save("ann", device("b"));
    await store.save("bob", device("c"));
    const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
    const sender = createPushSender({
      store,
      send: async (subscription, payload) => {
        sent.push({
          endpoint: subscription.endpoint,
          payload: JSON.parse(payload),
        });
        return { statusCode: 201 };
      },
    });
    const result = await sender.notify("ann", {
      title: "t".repeat(200),
      body: "b".repeat(500),
      url: "/channel/x",
      tag: "routine-1",
    });
    expect(result).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(sent.map((one) => one.endpoint).sort()).toEqual([
      device("a").endpoint,
      device("b").endpoint,
    ]);
    const first = sent[0];
    expect(first).toBeDefined();
    const payload = (first?.payload ?? {}) as Record<string, unknown>;
    expect(String(payload.title).length).toBeLessThanOrEqual(80);
    expect(String(payload.body).length).toBeLessThanOrEqual(200);
    expect(payload).toMatchObject({
      url: "/channel/x",
      tag: "routine-1",
    });
  });

  test("a device the service says is gone is forgotten; one that merely failed is kept", async () => {
    const { store, rows, removed } = memoryStore();
    await store.save("ann", device("gone"));
    await store.save("ann", device("busy"));
    await store.save("ann", device("fine"));
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const send: PushSend = async (subscription) => {
        if (subscription.endpoint.endsWith("gone"))
          throw Object.assign(new Error("Gone"), { statusCode: 410 });
        if (subscription.endpoint.endsWith("busy"))
          throw Object.assign(new Error("Too many"), { statusCode: 429 });
        return { statusCode: 201 };
      };
      const result = await createPushSender({ store, send }).notify("ann", {
        title: "x",
        body: "y",
      });
      expect(result).toEqual({ sent: 1, removed: 1, failed: 1 });
    } finally {
      console.error = original;
    }
    expect(removed).toEqual([device("gone").endpoint]);
    expect(rows.map((row) => row.endpoint).sort()).toEqual([
      device("busy").endpoint,
      device("fine").endpoint,
    ]);
    // The log says what kind of failure and nothing about whose device it was.
    expect(JSON.stringify(errors)).not.toContain("fcm.googleapis.com");
  });

  test("a person with no devices, or a store that cannot be read, is not an error", async () => {
    const { store } = memoryStore();
    const sender = createPushSender({
      store,
      send: async () => {
        throw new Error("must not be called");
      },
    });
    expect(await sender.notify("nobody", { title: "x", body: "y" })).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
    const broken = createPushSender({
      store: {
        ...store,
        forUser: async () => {
          throw new Error("database down");
        },
      },
      send: async () => ({ statusCode: 201 }),
    });
    expect(await broken.notify("ann", { title: "x", body: "y" })).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
  });

  test("the real sender builds an encrypted, signed request for the push service", async () => {
    const keys = webpush.generateVAPIDKeys();
    // A browser's own keys, as it would have made them when subscribing.
    const browser = (await import("node:crypto")).createECDH("prime256v1");
    browser.generateKeys();
    const details = webpush.generateRequestDetails(
      {
        endpoint: device("x").endpoint,
        keys: {
          p256dh: browser.getPublicKey().toString("base64url"),
          auth: Buffer.alloc(16, 5).toString("base64url"),
        },
      },
      JSON.stringify({ title: "hello" }),
      {
        vapidDetails: {
          subject: "https://app.example.com",
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 60,
      },
    );
    expect(details.method).toBe("POST");
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(details.headers.Authorization).toContain(keys.publicKey);
    expect(Buffer.isBuffer(details.body)).toBe(true);
    expect(details.body.toString()).not.toContain("hello");
    // And the function the server uses is constructed from the same pieces.
    expect(
      typeof webPushSend({ ...keys, subject: "https://app.example.com" }),
    ).toBe("function");
  });
});

describe("the routes", () => {
  const requireUser: Parameters<typeof pushRoutes>[0]["requireUser"] = async (
    context,
    next,
  ) => {
    const as = context.req.header("x-as");
    if (!as) return context.json({ error: "Sign in" }, 401);
    context.set("actor", { id: as, email: `${as}@example.com`, role: "user" });
    await next();
  };
  function build(clock = { now: 1_000_000 }) {
    const memory = memoryStore();
    const notified: string[] = [];
    const sender = {
      notify: async (userId: string) => {
        notified.push(userId);
        return { sent: 1, removed: 0, failed: 0 };
      },
    };
    const app = new Hono().route(
      "/api/push",
      pushRoutes({
        requireUser,
        store: memory.store,
        sender,
        publicKey: "PUBLIC",
        now: () => clock.now,
      }),
    );
    const call = (
      as: string | null,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      app.request(`/api/push${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(as ? { "x-as": as } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { ...memory, notified, call, clock };
  }
  const subscription = (name: string) => ({
    endpoint: device(name).endpoint,
    keys: { p256dh: device(name).p256dh, auth: device(name).auth },
  });

  test("nobody who is not signed in gets anything", async () => {
    const { call } = build();
    expect((await call(null, "GET", "")).status).toBe(401);
    expect(
      (await call(null, "PUT", "/subscription", subscription("a"))).status,
    ).toBe(401);
    expect((await call(null, "POST", "/test")).status).toBe(401);
  });

  test("a person registers a device, and is told the public key and how many they have", async () => {
    const { call } = build();
    expect(
      (await call("ann", "PUT", "/subscription", subscription("a"))).status,
    ).toBe(200);
    const body = (await (await call("ann", "GET", "")).json()) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ enabled: true, publicKey: "PUBLIC", devices: 1 });
    expect(JSON.stringify(body)).not.toContain(device("a").auth);
  });

  test("an address that is not a push service, or a malformed subscription, is refused", async () => {
    const { call, rows } = build();
    const internal = {
      ...subscription("a"),
      endpoint: "https://169.254.169.254/latest",
    };
    expect((await call("ann", "PUT", "/subscription", internal)).status).toBe(
      400,
    );
    expect(
      (await call("ann", "PUT", "/subscription", { endpoint: "x" })).status,
    ).toBe(400);
    expect(
      (
        await call("ann", "PUT", "/subscription", {
          ...subscription("a"),
          keys: { p256dh: "not base64!", auth: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("ann", "PUT", "/subscription", {
          ...subscription("a"),
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(rows).toEqual([]);
  });

  test("somebody else's device cannot be removed by asking", async () => {
    const { call, rows } = build();
    await call("ann", "PUT", "/subscription", subscription("a"));
    const attempt = await call("bob", "DELETE", "/subscription", {
      endpoint: device("a").endpoint,
    });
    // The same answer as for one that was theirs: a device is not something to find out about.
    expect(attempt.status).toBe(200);
    expect(rows).toHaveLength(1);
    await call("ann", "DELETE", "/subscription", {
      endpoint: device("a").endpoint,
    });
    expect(rows).toHaveLength(0);
  });

  test("a test notification goes to the person's own devices, and not twice in a row", async () => {
    const world = build();
    expect((await world.call("ann", "POST", "/test")).status).toBe(200);
    expect(world.notified).toEqual(["ann"]);
    expect((await world.call("ann", "POST", "/test")).status).toBe(429);
    expect((await world.call("bob", "POST", "/test")).status).toBe(200);
    world.clock.now += 11_000;
    expect((await world.call("ann", "POST", "/test")).status).toBe(200);
    expect(world.notified).toEqual(["ann", "bob", "ann"]);
  });
});

describe("a routine ending", () => {
  const routineStore = (failures: number) => ({
    runContext: async () => ({
      routineId: "r1",
      ownerUserId: "ann",
      agentId: "a1",
      channelId: "c/1",
      instruction: "do it",
    }),
    finishRun: async () => undefined,
    consecutiveFailures: async () => failures,
    setEnabled: async () => undefined,
  });
  const channelStore = {
    get: async () => ({ threadId: "t1" }),
    recordActivity: async () => undefined,
  };
  const run = async (options: {
    failures?: number;
    turn?: "ok" | "fail";
    notify?: (
      userId: string,
      message: Record<string, string>,
    ) => Promise<unknown>;
  }) => {
    const told: { userId: string; message: Record<string, string> }[] = [];
    const runner = createRoutineRunner({
      routineStore: routineStore(options.failures ?? 1) as never,
      channelStore: channelStore as never,
      runTurn: async () => {
        if (options.turn === "fail") throw new Error("the model said no");
        return { replyText: "all done, here are the private numbers" };
      },
      notify:
        options.notify ??
        (async (userId, message) => {
          told.push({ userId, message: message as Record<string, string> });
        }),
    });
    await runner.run("run-1");
    return told;
  };

  test("tells the owner, without saying what the routine was or did", async () => {
    const told = await run({});
    expect(told).toHaveLength(1);
    expect(told[0]?.userId).toBe("ann");
    expect(told[0]?.message.url).toBe("/channel/c%2F1");
    const text = JSON.stringify(told[0]);
    expect(text).not.toContain("private numbers");
    expect(text).not.toContain("do it");
  });

  test("tells the owner about the first failure and about being switched off, not about every one between", async () => {
    expect(
      (await run({ turn: "fail", failures: 1 })).map(
        (one) => one.message.title,
      ),
    ).toEqual(["A routine failed"]);
    expect(await run({ turn: "fail", failures: 4 })).toEqual([]);
    expect(
      (await run({ turn: "fail", failures: 10 })).map(
        (one) => one.message.title,
      ),
    ).toEqual(["A routine was switched off"]);
    expect(
      JSON.stringify(await run({ turn: "fail", failures: 1 })),
    ).not.toContain("the model said no");
  });

  test("a notification that cannot be sent does not change how the firing ends", async () => {
    const finished: string[] = [];
    const runner = createRoutineRunner({
      routineStore: {
        ...routineStore(1),
        finishRun: async (_id: string, status: string) => {
          finished.push(status);
        },
      } as never,
      channelStore: channelStore as never,
      runTurn: async () => ({ replyText: "ok" }),
      notify: async () => {
        throw new Error("push service down");
      },
    });
    await runner.run("run-1");
    expect(finished).toEqual(["succeeded"]);
  });
});
