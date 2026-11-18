/**
 * Settings → Phones (#149). Mounted at `/api/ark-link`.
 *
 * For administrators: switch Ark Link on, pair a phone, confirm it (for themselves, or for another
 * person on the install, who then accepts it), list the phones and remove one.
 * For everybody signed in: the phones that act as them, to accept or remove.
 *
 * None of it from a phone: phones are paired and managed at a computer, so a phone cannot pair
 * another. A phone may only see and remove the phones that are its own person's.
 *
 * The install token goes in once, in a masked field, and is never sent back.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isInstallToken } from "../../../shared/ark-link";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { cameThroughArkLink } from "./marker";
import { ArkLinkRefusedError, type ArkLinkService } from "./service";

const settings = z.strictObject({
  relayUrl: z.string().trim().url().max(300),
  installToken: z.string().trim().refine(isInstallToken).optional(),
  enabled: z.boolean(),
});
const confirm = z.strictObject({
  deviceName: z.string().trim().min(1).max(60),
  /** Who the phone is for. Absent: the person confirming it. */
  forUserId: z.string().min(1).max(200).optional(),
});
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE_ID = /^[0-9a-f-]{36}$/;

export const MANAGE_ON_COMPUTER =
  "Pair and manage phones on your computer, not from a phone.";

type RouteContext = Context<{ Variables: AppVariables }>;

/** An administrator at a computer; otherwise the answer to send. */
function adminAtComputer(context: RouteContext) {
  if (cameThroughArkLink(context.req.raw.headers))
    return context.json({ error: MANAGE_ON_COMPUTER }, 409);
  return requireAdmin(context);
}

export function createArkLinkRoutes(options: {
  arkLink: ArkLinkService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const { arkLink, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", requireUser);

  const refused = (error: unknown) => {
    if (error instanceof ArkLinkRefusedError) return error.message;
    throw error;
  };

  routes.get("/", async (context) => {
    const denied = adminAtComputer(context);
    if (denied) return denied;
    return context.json(await arkLink.view());
  });

  routes.put("/", async (context) => {
    const denied = adminAtComputer(context);
    if (denied) return denied;
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
    const denied = adminAtComputer(context);
    if (denied) return denied;
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
    const denied = adminAtComputer(context);
    if (denied) return denied;
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
          parsed.data.forUserId,
        ),
      );
    } catch (error) {
      return context.json({ error: refused(error) }, 409);
    }
  });

  routes.post("/pairing/:pairingId/refuse", async (context) => {
    const denied = adminAtComputer(context);
    if (denied) return denied;
    const pairingId = context.req.param("pairingId");
    if (!ID.test(pairingId))
      return context.json({ error: "No such phone." }, 404);
    await arkLink.refuse(context.var.actor.id, pairingId);
    return context.body(null, 204);
  });

  /** The phones that act as the signed-in person. */
  routes.get("/mine", async (context) =>
    context.json({ devices: await arkLink.mine(context.var.actor.id) }),
  );

  /** Only the person a phone was paired for, at their own computer. */
  routes.post("/devices/:id/accept", async (context) => {
    if (cameThroughArkLink(context.req.raw.headers))
      return context.json({ error: MANAGE_ON_COMPUTER }, 409);
    const id = context.req.param("id");
    if (!DEVICE_ID.test(id))
      return context.json({ error: "No such phone." }, 404);
    return (await arkLink.accept(context.var.actor.id, id))
      ? context.body(null, 204)
      : context.json({ error: "No such phone waits for you." }, 404);
  });

  /** An administrator removes any phone; anybody else, a phone that acts as them. */
  routes.delete("/devices/:id", async (context) => {
    const id = context.req.param("id");
    if (!DEVICE_ID.test(id))
      return context.json({ error: "No such phone." }, 404);
    const admin =
      context.var.actor.role === "admin" &&
      !cameThroughArkLink(context.req.raw.headers);
    return (await arkLink.removeDevice(
      context.var.actor.id,
      id,
      admin ? undefined : context.var.actor.id,
    ))
      ? context.body(null, 204)
      : context.json({ error: "No such phone." }, 404);
  });

  return routes;
}
