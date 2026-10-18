import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createMemoryRoutes } from "../src/memories/routes";
import {
  type Memory,
  MemoryNotFoundError,
  MemoryRefusedError,
  type MemoryStore,
} from "../src/memories/store";

const actor = { id: "user-1", email: "a@example.test", role: "user" } as const;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const kept: Memory = {
  id: "mem_1",
  agentId: "ana",
  content: "Prefers email.",
  source: "person",
  createdAt: new Date("2026-10-18T10:00:00Z"),
  updatedAt: new Date("2026-10-18T10:00:00Z"),
};

function appFor(store: Partial<MemoryStore>) {
  const outer = new Hono<{ Variables: AppVariables }>();
  outer.route(
    "/api/agents/:agentId/memories",
    createMemoryRoutes(store as MemoryStore, requireUser),
  );
  return outer;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("memory routes", () => {
  test("list, for the signed-in person and the employee in the path", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      list: async (...args) => {
        calls.push(args);
        return [kept];
      },
    });
    const body = await (await app.request("/api/agents/ana/memories")).json();
    expect(body.memories[0]).toMatchObject({
      id: "mem_1",
      content: "Prefers email.",
    });
    expect(calls).toEqual([["user-1", "ana"]]);
  });

  test("adding is the person's own, and says so", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      add: async (input) => {
        calls.push(input);
        return kept;
      },
    });
    const response = await app.request(
      "/api/agents/ana/memories",
      json({ content: "Prefers email." }),
    );
    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        ownerUserId: "user-1",
        agentId: "ana",
        content: "Prefers email.",
        source: "person",
      },
    ]);
  });

  test("a refusal is a 400 in words, a missing memory a 404, a delete a 204", async () => {
    const refusing = appFor({
      add: async () => {
        throw new MemoryRefusedError("Those are never kept.");
      },
    });
    const refused = await refusing.request(
      "/api/agents/ana/memories",
      json({ content: "x" }),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("Those are never kept.");

    const missing = appFor({
      update: async () => {
        throw new MemoryNotFoundError();
      },
      remove: async () => {
        throw new MemoryNotFoundError();
      },
    });
    expect(
      (
        await missing.request("/api/agents/ana/memories/mem_x", {
          ...json({ content: "y" }),
          method: "PATCH",
        })
      ).status,
    ).toBe(404);

    const removing = appFor({ remove: async () => {} });
    expect(
      (
        await removing.request("/api/agents/ana/memories/mem_1", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });

  test("a body without text is refused before the store is asked", async () => {
    const calls: unknown[] = [];
    const app = appFor({
      add: async (input) => {
        calls.push(input);
        return kept;
      },
    });
    const response = await app.request("/api/agents/ana/memories", json({}));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
