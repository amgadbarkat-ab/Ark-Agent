/**
 * The weekly summary and cleanup over HTTP, at `/api/chat-summary/:agentId`, for the signed-in person
 * and their own row only:
 * - GET  /?tz=<IANA zone>  whether it is on, the summary file, when it was made; the person's time zone
 *                          is kept so the run falls outside their business hours
 * - PUT  /  {enabled}      switch it on or off (switching off: the app shows Amgad's warning first)
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { ChatSummaryService } from "./service";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

const ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

export function chatSummaryRoutes(
  requireUser: Middleware,
  service: ChatSummaryService,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  const known = (agentId: string) => service.agentExists(agentId);

  app.get("/:agentId", async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await known(agentId)))
      return context.json({ error: "Agent not found." }, 404);
    const tz = context.req.query("tz") ?? "";
    return context.json(
      await service.view(
        context.var.actor.id,
        agentId,
        ZONE.test(tz) && tz.length <= 64 ? tz : undefined,
      ),
    );
  });

  app.put("/:agentId", async (context) => {
    const agentId = context.req.param("agentId");
    const parsed = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "Say on or off." }, 400);
    if (!(await known(agentId)))
      return context.json({ error: "Agent not found." }, 404);
    await service.setEnabled(
      context.var.actor.id,
      agentId,
      parsed.data.enabled,
    );
    return context.json(await service.view(context.var.actor.id, agentId));
  });

  return app;
}
