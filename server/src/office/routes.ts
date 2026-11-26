import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { OfficeService } from "./service";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

/**
 * The office network, for the administrator (Settings, then Team):
 *
 * - GET  /   whether it is on, the addresses, and the join code to give staff
 * - PUT  /   `{ enabled?, remote? }`: switch the office network, or remote staff, on or off
 * - POST /join-code   a new join code; the old one stops getting through BlackArk's relay
 */
export function officeRoutes(requireUser: Middleware, office: OfficeService) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await office.status());
  });

  const body = z
    .strictObject({
      enabled: z.boolean().optional(),
      remote: z.boolean().optional(),
    })
    .refine(
      (value) => value.enabled !== undefined || value.remote !== undefined,
    );
  app.put("/", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = body.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json({ error: "Say whether it is on or off." }, 400);
    if (parsed.data.enabled !== undefined)
      await office.setEnabled(parsed.data.enabled);
    if (parsed.data.remote !== undefined) {
      if (parsed.data.remote && !(await office.status()).remote.available)
        return context.json(
          { error: "This ArkAgent cannot use BlackArk's staff relay." },
          409,
        );
      await office.setRemote(parsed.data.remote);
    }
    return context.json(await office.status());
  });

  /** A new join code: the one given out before stops getting through BlackArk's relay. */
  app.post("/join-code", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await office.newJoinCode());
  });

  return app;
}

/** The certificate a staff computer checks against its join code. Public: it admits nobody. */
export function officeCertificateRoutes(office: OfficeService) {
  const app = new Hono();
  app.get("/", async (context) => {
    const pem = await office.certificatePem();
    if (!pem) return context.json({ error: "Not switched on." }, 404);
    context.header("cache-control", "no-store");
    return context.text(pem);
  });
  return app;
}
