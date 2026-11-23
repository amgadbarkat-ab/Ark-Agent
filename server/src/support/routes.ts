/**
 * Help & support over HTTP (#149), at `/api/support`, for the signed-in person:
 * - GET  /           whether this install can send a request, whether it is verified (activated,
 *                    so BlackArk knows whose it is), and the person's requests
 * - POST /preview    exactly what would be sent, for the person to read first
 * - POST /requests   send it (kept and sent again later if BlackArk cannot be reached)
 * - GET  /replies    BlackArk's replies to the person's own requests (Gap 3); `available` false
 *                    when they cannot be fetched now
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { type SupportService, SupportUnavailableError } from "./service";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

const body = z.strictObject({
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(10).max(8000),
  urgent: z.boolean(),
  includeDiagnostics: z.boolean(),
  language: z.enum(["el", "en"]),
  // Before activation only; empty means none given.
  contactEmail: z
    .union([z.literal(""), z.string().trim().email().max(254)])
    .optional(),
});
const sendBody = body.extend({ previewId: z.string().uuid().optional() });

export function supportRoutes(
  requireUser: Middleware,
  service: SupportService,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/", async (context) =>
    context.json({
      available: await service.available(),
      verified: await service.verified(),
      requests: await service.list(context.var.actor.id),
    }),
  );

  app.get("/replies", async (context) => {
    const cases = await service.replies(context.var.actor.id);
    return context.json({ available: cases !== null, cases: cases ?? [] });
  });

  const read = async (raw: unknown) => body.safeParse(raw);

  app.post("/preview", async (context) => {
    const parsed = await read(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json({ error: "Write a subject and what happened." }, 400);
    try {
      return context.json({
        payload: await service.preview(context.var.actor.id, parsed.data),
      });
    } catch (error) {
      if (error instanceof SupportUnavailableError)
        return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.post("/requests", async (context) => {
    const parsed = sendBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: "Write a subject and what happened." }, 400);
    const { previewId: _previewId, ...input } = parsed.data;
    try {
      return context.json(
        {
          request: await service.submit(
            context.var.actor.id,
            input,
            parsed.data.previewId,
          ),
        },
        201,
      );
    } catch (error) {
      if (error instanceof SupportUnavailableError)
        return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}
