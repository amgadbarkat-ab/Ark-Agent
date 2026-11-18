/**
 * Settings → Phones (#149), for administrators: switch Ark Link on, pair a phone, confirm it, list
 * the phones and remove one. Mounted at `/api/ark-link`.
 *
 * The install token goes in once, in a masked field, and is never sent back.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isInstallToken } from "../../../shared/ark-link";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { ArkLinkRefusedError, type ArkLinkService } from "./service";

const settings = z.strictObject({
  relayUrl: z.string().trim().url().max(300),
  installToken: z.string().trim().refine(isInstallToken).optional(),
  enabled: z.boolean(),
});
const confirm = z.strictObject({
  deviceName: z.string().trim().min(1).max(60),
});
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createArkLinkRoutes(options: {
  arkLink: ArkLinkService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const { arkLink, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  const refused = (error: unknown) => {
    if (error instanceof ArkLinkRefusedError) return error.message;
    throw error;
  };

  routes.get("/", async (context) => context.json(await arkLink.view()));

  routes.put("/", async (context) => {
    const parsed = settings.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        {
          error:
            "Check the relay address and the install token (it starts arki_).",
        },
        400,
      );
    try {
      return context.json(
        await arkLink.save(context.var.actor.id, parsed.data),
      );
    } catch (error) {
      return context.json({ error: refused(error) }, 400);
    }
  });

  routes.post("/pairing", async (context) => {
    try {
      return context.json(await arkLink.startPairing(context.var.actor.id));
    } catch (error) {
      if (error instanceof ArkLinkRefusedError)
        return context.json({ error: error.message }, 409);
      return context.json(
        { error: "The relay did not answer. Try again." },
        502,
      );
    }
  });

  routes.post("/pairing/:pairingId/confirm", async (context) => {
    const pairingId = context.req.param("pairingId");
    const parsed = confirm.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!ID.test(pairingId) || !parsed.success)
      return context.json({ error: "Give the phone a name." }, 400);
    try {
      return context.json(
        await arkLink.confirm(
          context.var.actor.id,
          pairingId,
          parsed.data.deviceName,
        ),
      );
    } catch (error) {
      return context.json({ error: refused(error) }, 409);
    }
  });

  routes.post("/pairing/:pairingId/refuse", async (context) => {
    const pairingId = context.req.param("pairingId");
    if (!ID.test(pairingId))
      return context.json({ error: "No such phone." }, 404);
    await arkLink.refuse(context.var.actor.id, pairingId);
    return context.body(null, 204);
  });

  routes.delete("/devices/:id", async (context) => {
    const id = context.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id))
      return context.json({ error: "No such phone." }, 404);
    return (await arkLink.removeDevice(context.var.actor.id, id))
      ? context.body(null, 204)
      : context.json({ error: "No such phone." }, 404);
  });

  return routes;
}
