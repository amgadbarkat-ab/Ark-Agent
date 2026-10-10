import { createReadiness } from "../../shared/readiness";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Hub } from "./hub";
import { Conflict, LockConflict, NotFound } from "./store";

const nonEmpty = z.string().min(1);

const createThread = z.object({
  threadId: nonEmpty,
  userId: nonEmpty,
  agentId: nonEmpty,
  name: z.string().optional(),
});
const updateThread = z.object({
  userId: nonEmpty,
  agentId: z.string().optional(),
  name: z.string().optional(),
  archived: z.boolean().optional(),
});
const deleteThread = z.object({ userId: nonEmpty });
const acquireLock = z.object({
  runId: nonEmpty,
  userId: nonEmpty,
  agentId: nonEmpty,
  ttlSeconds: z.number().int().positive().optional(),
  lockKeyPrefix: z.string().optional(),
});
const renewLock = z.object({
  runId: nonEmpty,
  ttlSeconds: z.number().int().positive(),
});
const releaseLock = z.object({ runId: nonEmpty });
const subscribe = z.object({ userId: nonEmpty });
const connect = z.object({ userId: nonEmpty, agentId: z.string().optional() });

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The HTTP API the CopilotKit SDK's Intelligence client calls. */
export function createRestApp(hub: Hub) {
  const app = new Hono();
  const { store, config } = hub;

  app.get("/health", (c) => c.json({ status: "ok" }));
  // Whether to send this process requests: the database answers, and it has not been told to stop.
  // `/health` stays the question of whether it is alive, and does not ask the database.
  const ready = createReadiness({
    ping: () => store.ping(),
    draining: () => hub.draining,
  });
  app.get("/ready", async (c) => {
    const answer = await ready();
    return c.json({ status: answer.status }, answer.ok ? 200 : 503);
  });

  const authenticate = async (
    c: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !safeEqual(token, config.apiKey)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
  app.use("/api/*", authenticate);
  app.use("/connector/*", authenticate);

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json({ error: "invalid request", issues: error.issues }, 400);
    }
    if (error instanceof NotFound) return c.json({ error: error.message }, 404);
    if (error instanceof Conflict) return c.json({ error: error.message }, 409);
    if (error instanceof LockConflict) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof SyntaxError) {
      return c.json({ error: "request body is not valid JSON" }, 400);
    }
    console.error("hub request failed", error);
    return c.json({ error: "internal error" }, 500);
  });

  const body = async <T>(
    c: { req: { text(): Promise<string> } },
    schema: z.ZodType<T>,
  ): Promise<T> => {
    const text = await c.req.text();
    return schema.parse(text ? JSON.parse(text) : {});
  };

  // ---- entitlements and inspector -----------------------------------------

  // This deployment is its own licence: everything is on, nothing is metered by a third party.
  app.get("/api/entitlements/runtime", (c) =>
    c.json({
      status: "ready",
      entitlement: {
        active: true,
        source: "selfHostedDeploymentLicense",
        features: {},
        limits: {},
        planCode: "ark-hub",
      },
    }),
  );
  app.get("/api/inspector/metadata", (c) => c.body(null, 204));

  // ---- threads -------------------------------------------------------------

  app.get("/api/threads", async (c) => {
    const userId = c.req.query("userId");
    if (!userId) return c.json({ error: "userId is required" }, 400);
    const limit = c.req.query("limit");
    const { threads, nextCursor } = await store.listThreads({
      userId,
      agentId: c.req.query("agentId") || undefined,
      includeArchived: c.req.query("includeArchived") === "true",
      ...(limit ? { limit: Number(limit) } : {}),
      cursor: c.req.query("cursor") || undefined,
    });
    return c.json({
      threads,
      joinCode: hub.metaTopic(userId).slice("user_meta:".length),
      joinToken: hub.metaToken(userId),
      nextCursor,
    });
  });

  app.post("/api/threads/subscribe", async (c) => {
    const { userId } = await body(c, subscribe);
    return c.json({ joinToken: hub.metaToken(userId) });
  });

  app.post("/api/threads", async (c) => {
    const input = await body(c, createThread);
    const thread = await store.createThread(input);
    hub.announceThread("created", thread);
    return c.json({ thread }, 201);
  });

  app.get("/api/threads/:id", async (c) => {
    const userId = c.req.query("userId");
    if (!userId) return c.json({ error: "userId is required" }, 400);
    const thread = await store.getThread(c.req.param("id"), userId);
    return thread
      ? c.json({ thread })
      : c.json({ error: "thread not found" }, 404);
  });

  app.patch("/api/threads/:id", async (c) => {
    const input = await body(c, updateThread);
    const before = await store.getThread(c.req.param("id"), input.userId);
    const thread = await store.updateThread({
      threadId: c.req.param("id"),
      userId: input.userId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    });
    if (!thread) return c.json({ error: "thread not found" }, 404);
    hub.announceThread(
      input.archived === true && !before?.archived ? "archived" : "updated",
      thread,
    );
    return c.json({ thread });
  });

  app.delete("/api/threads/:id", async (c) => {
    const { userId } = await body(c, deleteThread);
    const thread = await store.getThread(c.req.param("id"), userId);
    if (!thread || !(await store.deleteThread(thread.id, userId))) {
      return c.json({ error: "thread not found" }, 404);
    }
    hub.announceThread("deleted", thread);
    return c.json({ deleted: true });
  });

  app.get("/api/threads/:id/messages", async (c) => {
    const userId = c.req.query("userId");
    if (!userId) return c.json({ error: "userId is required" }, 400);
    const id = c.req.param("id");
    if (!(await store.getThread(id, userId))) {
      return c.json({ error: "thread not found" }, 404);
    }
    return c.json({ messages: await store.threadMessages(id) });
  });

  // ---- run lock ------------------------------------------------------------

  app.post("/api/threads/:id/lock", async (c) => {
    const input = await body(c, acquireLock);
    const threadId = c.req.param("id");
    const grant = await store.acquireLock({
      threadId,
      runId: input.runId,
      userId: input.userId,
      agentId: input.agentId,
      ttlSeconds: input.ttlSeconds ?? config.defaultLockTtlSeconds,
      ...(input.lockKeyPrefix !== undefined
        ? { lockKeyPrefix: input.lockKeyPrefix }
        : {}),
    });
    return c.json({
      threadId: grant.threadId,
      runId: grant.runId,
      joinToken: hub.threadToken(threadId, input.userId),
      lock: grant.lock,
    });
  });

  app.patch("/api/threads/:id/lock", async (c) => {
    const input = await body(c, renewLock);
    const renewed = await store.renewLock({
      threadId: c.req.param("id"),
      runId: input.runId,
      ttlSeconds: input.ttlSeconds,
    });
    return renewed
      ? c.json({ ttlSeconds: input.ttlSeconds })
      : c.json({ error: "lock not held by this run" }, 404);
  });

  app.delete("/api/threads/:id/lock", async (c) => {
    const input = await body(c, releaseLock);
    await store.releaseLock(c.req.param("id"), input.runId);
    return c.json({ released: true });
  });

  // ---- joining -------------------------------------------------------------

  app.get("/api/threads/:id/join-code", async (c) => {
    const userId = c.req.query("userId");
    if (!userId) return c.json({ error: "userId is required" }, 400);
    const threadId = c.req.param("id");
    if (!(await store.getThread(threadId, userId))) {
      return c.json({ error: "thread not found" }, 404);
    }
    return c.json({
      joinCode: threadId,
      joinToken: hub.threadToken(threadId, userId),
    });
  });

  // Nothing to connect to is an empty answer, not an error: the browser treats a thread that does
  // not exist yet as a blank conversation.
  app.post("/api/threads/:id/connect", async (c) => {
    const { userId } = await body(c, connect);
    const threadId = c.req.param("id");
    if (!(await store.getThread(threadId, userId))) return c.body(null, 204);
    const lock = await store.activeLock(threadId);
    return c.json({
      threadId,
      ...(lock ? { runId: lock.runId } : {}),
      joinToken: hub.threadToken(threadId, userId),
      ...(lock ? { lock: { key: lock.key, ttlSeconds: null } } : {}),
    });
  });

  // ---- features this deployment does not provide ---------------------------

  app.all("/api/memories/*", (c) =>
    c.json({ error: "memories are not available" }, 404),
  );
  app.all("/api/memories", (c) =>
    c.json({ error: "memories are not available" }, 404),
  );
  app.all("/api/_inspect/*", (c) =>
    c.json({ error: "inspection is not available" }, 404),
  );
  app.all("/api/channels/*", (c) =>
    c.json({ error: "managed channels are not available" }, 404),
  );

  // Feedback annotations are accepted and acknowledged, not kept.
  app.put("/connector/annotate/:id", (c) => c.json({ duplicate: false }));

  return app;
}
