/**
 * Ark Private Server over HTTP (#149), at `/api/private-server`, for administrators (buying a server is
 * the business's decision, as the plan is):
 * - GET  /         the tiers, BlackArk's buy page, this customer's order, and whether it is connected
 * - POST /connect  put the ready server into the person's model connections and make it their default
 *
 * No key is ever in an answer.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  PrivateServerNotReadyError,
  type PrivateServerService,
} from "./service";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

export function privateServerRoutes(
  requireUser: Middleware,
  service: PrivateServerService,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await service.view(context.var.actor.id));
  });

  app.post("/connect", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      const connection = await service.connect(context.var.actor.id);
      return context.json({
        connection: {
          id: connection.id,
          label: connection.label,
          model: connection.model,
          isDefault: connection.isDefault,
        },
      });
    } catch (error) {
      if (error instanceof PrivateServerNotReadyError)
        return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}
