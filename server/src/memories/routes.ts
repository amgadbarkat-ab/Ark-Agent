import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  type Memory,
  MemoryNotFoundError,
  MemoryRefusedError,
  type MemoryStore,
} from "./store";

/**
 * A digital employee's memories, for the person who owns it: read them, add one, correct one, delete
 * one. Mounted under the employee (`/api/agents/:agentId/memories`), so the page for an employee is
 * the page for what it keeps in mind.
 *
 * Owner-scoped through the store on every call; somebody else's memory, or an employee that is not
 * yours, reads as missing or refuses in words, never as another person's text.
 */
export function createMemoryRoutes(
  store: MemoryStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const contentOf = async (request: Request): Promise<string | null> => {
    const body = (await request.json().catch(() => null)) as {
      content?: unknown;
    } | null;
    return typeof body?.content === "string" ? body.content : null;
  };

  const failure = (
    context: { json: (body: unknown, status: 400 | 404) => Response },
    error: unknown,
  ) => {
    if (error instanceof MemoryRefusedError) {
      return context.json({ error: error.message }, 400);
    }
    if (error instanceof MemoryNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    throw error;
  };

  routes.get("/", requireUser, async (context) => {
    const agentId = context.req.param("agentId") ?? "";
    const memories = await store.list(context.var.actor.id, agentId);
    return context.json({ memories: memories.map(dto) });
  });

  routes.post("/", requireUser, async (context) => {
    const content = await contentOf(context.req.raw);
    if (content === null) {
      return context.json({ error: "A memory has to say something." }, 400);
    }
    try {
      const memory = await store.add({
        ownerUserId: context.var.actor.id,
        agentId: context.req.param("agentId") ?? "",
        content,
        source: "person",
      });
      return context.json({ memory: dto(memory) }, 201);
    } catch (error) {
      return failure(context, error);
    }
  });

  routes.patch("/:id", requireUser, async (context) => {
    const content = await contentOf(context.req.raw);
    if (content === null) {
      return context.json({ error: "A memory has to say something." }, 400);
    }
    try {
      const memory = await store.update(
        context.var.actor.id,
        context.req.param("id"),
        content,
        "person",
      );
      return context.json({ memory: dto(memory) });
    } catch (error) {
      return failure(context, error);
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    try {
      await store.remove(context.var.actor.id, context.req.param("id"));
      return context.body(null, 204);
    } catch (error) {
      return failure(context, error);
    }
  });

  return routes;
}

function dto(memory: Memory) {
  return {
    id: memory.id,
    content: memory.content,
    source: memory.source,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}
