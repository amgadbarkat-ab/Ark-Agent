/**
 * The business's phone line (#109), for administrators: set it up, switch it off, remove it, and
 * read the call log. Mounted at `/api/phone-line`.
 *
 * The line token and the speech key go in once, in masked fields, and are never sent back.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { PhoneLineRefusedError, type PhoneLineService } from "./service";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z
  .strictObject({ from: time, to: time })
  .refine((d) => d.from < d.to);

const body = z.strictObject({
  relayUrl: z.string().trim().url().max(300),
  lineToken: z.string().trim().min(20).max(200).optional(),
  speechKey: z.string().trim().min(10).max(400).optional(),
  agentId: z.string().min(1).max(200),
  speechModel: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,80}$/),
  voice: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,40}$/),
  greeting: z.string().trim().min(1).max(300),
  hours: z
    .strictObject({
      "0": day.optional(),
      "1": day.optional(),
      "2": day.optional(),
      "3": day.optional(),
      "4": day.optional(),
      "5": day.optional(),
      "6": day.optional(),
    })
    .nullable(),
  enabled: z.boolean(),
});

export function createPhoneLineRoutes(options: {
  phoneLine: PhoneLineService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const { phoneLine, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ line: await phoneLine.settings() });
  });

  routes.put("/", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = body.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(
        {
          error:
            "Check the relay address, the employee, the voice, the greeting and the hours.",
        },
        400,
      );
    }
    try {
      return context.json({
        line: await phoneLine.save(context.var.actor.id, parsed.data),
      });
    } catch (error) {
      if (error instanceof PhoneLineRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.delete("/", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await phoneLine.remove(context.var.actor.id);
    return context.body(null, 204);
  });

  routes.get("/calls", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({ calls: await phoneLine.calls(50) });
  });

  routes.post("/calls/:id/callback-done", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const id = context.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id))
      return context.json({ error: "No such call." }, 404);
    return (await phoneLine.markCallbackDone(id))
      ? context.body(null, 204)
      : context.json(
          { error: "No such callback, or it is already done." },
          404,
        );
  });

  return routes;
}
