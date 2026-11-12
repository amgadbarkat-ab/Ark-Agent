import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { PluginStore } from "./store";

/**
 * MCP Apps (P2 idea 9B, desk #90): the interface an MCP server ships for a tool's results, handed to
 * the chat to draw in a sandboxed frame.
 *
 * MOUNTED ONLY WHEN `MCP_APPS_ENABLED=true`. Off, the chat asks `GET /` once, is told 404, and draws
 * every tool exactly as before. On, nothing here runs a tool: the frame's own requests to act are
 * put to the conversation as the person's message, so the employee makes the call and a write
 * waits for approval like any other (see `mcp-app-frame.tsx`).
 */
export function createMcpAppRoutes(options: {
  store: Pick<PluginStore, "toolInterface">;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const { store, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, (context) => context.json({ enabled: true }));

  /** `?tool=mcp__<server>__<tool>`: the tool's interface, or 204 when it has none. */
  routes.get("/interface", requireUser, async (context) => {
    const parsed = toolRef(context.req.query("tool") ?? "");
    if (!parsed) return context.json({ error: "Name one tool." }, 400);
    try {
      const html = await store.toolInterface({
        ...parsed,
        actorId: context.var.actor.id,
      });
      if (html === null) return context.body(null, 204);
      return context.json({ html });
    } catch {
      // Not connected, refused, or the server did not answer: the chat draws the text instead.
      return context.body(null, 204);
    }
  });

  return routes;
}

/** `mcp__<server>__<tool>` as the chat names a call, or null. */
export function toolRef(
  name: string,
): { serverId: string; toolName: string } | null {
  const [prefix, serverId, ...rest] = name.split("__");
  const toolName = rest.join("__");
  if (prefix !== "mcp" || !serverId || !toolName || name.length > 300) {
    return null;
  }
  return { serverId, toolName };
}
