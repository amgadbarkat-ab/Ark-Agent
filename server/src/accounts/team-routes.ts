/**
 * A customer's team over HTTP (accounts/team.ts), at `/api/team`:
 * - GET  /setup               whether this ArkAgent still needs its administrator (no sign-in)
 * - POST /setup               {name, email, password}: makes the administrator, once (no sign-in)
 * - GET  /me                  the signed-in person's role, status, and whether to change the password
 * - POST /me/password         {current, next}: the first sign-in's new password
 * - GET  /                    the team (administrator)
 * - POST /members             {name, email, password, agentIds, move?}: a sub-profile (administrator)
 * - PUT  /members/:id/agents  {agentIds, move?}: which employees it has (administrator)
 * - DELETE /members/:id       takes it off the team (administrator)
 * - POST /billing/sync        BlackArk's paid number applied now (administrator)
 * A 409 from a member change with `conflicts` lists the employees another person has, and who: the
 * app asks the administrator to confirm, then sends `move: true`.
 */
import { timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { TeamError, type TeamService } from "./team";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

const person = {
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
};
const memberBody = z.strictObject({
  ...person,
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(200),
  move: z.boolean().optional(),
});
const agentsBody = z.strictObject({
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(200),
  move: z.boolean().optional(),
});

function failed(error: unknown) {
  if (error instanceof TeamError)
    return {
      status: error.status,
      body: {
        error: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      },
    };
  throw error;
}

/** The header the install's own window sends its set-up secret in. */
export const SETUP_TOKEN_HEADER = "x-ark-setup-token";

function sameSecret(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Mounted before sign-in: only whether set-up is needed, and the set-up itself, once.
 *
 * With `setupToken` (the desktop, security review of v0.1.54): only the install's own window can make
 * the administrator. The desktop gives that window the secret, and nothing else on the computer or
 * on a web page knows it, so an upgraded install waiting for its administrator cannot be claimed
 * first by somebody else.
 */
export function teamSetupRoutes(
  service: TeamService,
  options: { setupToken?: string } = {},
) {
  const app = new Hono();
  app.get("/setup", async (context) =>
    context.json({ needed: await service.setupNeeded() }),
  );
  app.post("/setup", async (context) => {
    const expected = options.setupToken?.trim();
    if (
      expected &&
      !sameSecret(context.req.header(SETUP_TOKEN_HEADER) ?? "", expected)
    )
      return context.json(
        {
          error:
            "Make the administrator's account in the ArkAgent window on this computer.",
          code: "setup_window_only",
        },
        403,
      );
    const parsed = z
      .strictObject(person)
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        {
          error:
            "Write a name, an email and a password of 10 or more characters.",
        },
        400,
      );
    try {
      return context.json(await service.setup(parsed.data), 201);
    } catch (error) {
      const { status, body } = failed(error);
      return context.json(body, status);
    }
  });
  return app;
}

export function teamRoutes(requireUser: Middleware, service: TeamService) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  const run = async (
    // biome-ignore lint/suspicious/noExplicitAny: every route's own path type
    context: Context<{ Variables: AppVariables }, any>,
    work: () => Promise<unknown>,
    ok = 200 as 200 | 201,
  ) => {
    try {
      return context.json((await work()) ?? {}, ok);
    } catch (error) {
      const { status, body } = failed(error);
      return context.json(body, status);
    }
  };

  app.get("/me", (context) =>
    run(context, () => service.me(context.var.actor.id)),
  );
  app.post("/me/password", async (context) => {
    const parsed = z
      .strictObject({
        current: z.string().max(128),
        next: z.string().min(10).max(128),
      })
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        { error: "The new password must be 10 to 128 characters." },
        400,
      );
    return run(context, () =>
      service.changePassword(
        context.var.actor.id,
        parsed.data.current,
        parsed.data.next,
      ),
    );
  });
  app.get("/", (context) =>
    run(context, async () => ({
      members: await service.list(context.var.actor.id),
    })),
  );
  app.post("/members", async (context) => {
    const parsed = memberBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        {
          error:
            "Write a name, an email, a password of 10 or more characters, and choose at least one digital employee.",
        },
        400,
      );
    return run(
      context,
      () => service.addSubprofile(context.var.actor.id, parsed.data),
      201,
    );
  });
  app.put("/members/:id/agents", async (context) => {
    const parsed = agentsBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json(
        { error: "Choose at least one digital employee." },
        400,
      );
    return run(context, () =>
      service.setAgents(
        context.var.actor.id,
        context.req.param("id"),
        parsed.data.agentIds,
        parsed.data.move === true,
      ),
    );
  });
  app.delete("/members/:id", (context) =>
    run(context, () =>
      service.remove(context.var.actor.id, context.req.param("id")),
    ),
  );
  app.post("/billing/sync", (context) =>
    run(context, async () => {
      // The administrator only, checked before BlackArk is asked (security review, 25 Nov).
      await service.list(context.var.actor.id);
      await service.syncBilling();
      return { members: await service.list(context.var.actor.id) };
    }),
  );
  return app;
}
