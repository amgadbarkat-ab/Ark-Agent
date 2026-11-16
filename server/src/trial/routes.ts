/**
 * The trial over HTTP (#109, v0.1.37).
 *
 * `/api/trial`: what the trial on this install is, importing a profile, entering an unlock code.
 * Reading it also sets up the roster for the person asking, once, so the first screen after an
 * import already shows the trial employees.
 *
 * `/api/trial-checkins`: BlackArk's own server only (ARK_TRIAL_RECEIVER=true). Installs report
 * status and days left here, and `/api/admin/trials` lists what they reported. Nothing else.
 */
import { desc, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { trialCheckIns } from "../db/schema";
import type { ActivationService } from "./activation";
import { TrialRefusedError, type TrialService } from "./service";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

export type TrialAudit = (event: {
  eventType:
    | "trial.profile_imported"
    | "trial.code_applied"
    | "activation.code_applied";
  actorUserId: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

export type TrialRouteDependencies = {
  service: TrialService;
  /** Sets up the roster for this person; how is index.ts's business. */
  seedFor: (actor: AgentActor) => Promise<number>;
  /** Whether this build can check a signature at all. */
  keyConfigured: boolean;
  audit?: TrialAudit;
  /** BlackArk's own server: receives check-ins and lists them. */
  receiver?: { database: Database };
  /** Trial activation codes and licence keys (v0.1.42), at `/api/activation`. */
  activation?: ActivationService;
};

const profileBody = z.strictObject({ text: z.string().min(2).max(400_000) });
const codeBody = z.strictObject({ code: z.string().min(8).max(4_000) });
const checkInBody = z.strictObject({
  customerId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  installId: z.string().uuid(),
  version: z.string().min(1).max(40),
  status: z.enum(["trial", "ended", "paid"]),
  daysLeft: z.number().int().min(0).max(10_000),
  endsAt: z.string().datetime().optional(),
  employees: z.number().int().min(0).max(1_000).optional(),
  /** From v0.1.38: the install's signed profile. Accepted and not stored. */
  proof: z
    .strictObject({
      profile: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(700_000),
      signature: z
        .string()
        .regex(/^[A-Za-z0-9_-]+$/)
        .max(200),
    })
    .optional(),
});

async function seedQuietly(
  seedFor: TrialRouteDependencies["seedFor"],
  actor: AgentActor,
) {
  try {
    await seedFor(actor);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "trial-seed-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export function trialRoutes(
  requireUser: Middleware,
  dependencies: TrialRouteDependencies,
) {
  const { service, seedFor, audit } = dependencies;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/", async (context) => {
    let trial = await service.current();
    if (trial) {
      await seedQuietly(seedFor, context.var.actor);
      trial = await service.current();
    }
    return context.json({ trial, keyConfigured: dependencies.keyConfigured });
  });

  app.post("/profile", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = profileBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json({ error: "Choose a trial profile file." }, 400);
    }
    try {
      const { trial, changed } = await service.importProfile(parsed.data.text);
      await seedQuietly(seedFor, context.var.actor);
      if (changed) {
        await audit?.({
          eventType: "trial.profile_imported",
          actorUserId: context.var.actor.id,
          payload: {
            customer: trial.customerId,
            endsAt: trial.endsAt,
            employees: trial.rosterSize,
            createBlocked: trial.createBlocked,
          },
        });
      }
      return context.json({ trial: await service.current(), changed });
    } catch (error) {
      if (error instanceof TrialRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.post("/unlock", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = codeBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json({ error: "Enter the unlock code." }, 400);
    }
    try {
      const { action, trial } = await service.applyCode(parsed.data.code);
      await audit?.({
        eventType: "trial.code_applied",
        actorUserId: context.var.actor.id,
        payload: { customer: trial.customerId, action, endsAt: trial.endsAt },
      });
      return context.json({ trial, action });
    } catch (error) {
      if (error instanceof TrialRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  return app;
}

/** Where installs report. No sign-in: an install has none. Only status and days left are kept. */
export function trialCheckInRoutes(database: Database) {
  const app = new Hono();
  app.post("/", async (context) => {
    const length = Number(context.req.header("content-length") ?? "0");
    if (length > 800_000) return context.json({ error: "Too large." }, 413);
    const parsed = checkInBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) return context.json({ error: "Not a check-in." }, 400);
    const body = parsed.data;
    const values = {
      customerId: body.customerId,
      version: body.version,
      status: body.status,
      daysLeft: body.daysLeft,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      employees: body.employees ?? null,
      lastSeenAt: new Date(),
    };
    await database
      .insert(trialCheckIns)
      .values({ installId: body.installId, ...values })
      .onConflictDoUpdate({ target: trialCheckIns.installId, set: values });
    return context.body(null, 204);
  });
  return app;
}

/** The administrator's list of what installs reported, latest first. */
export function adminTrialRoutes(requireUser: Middleware, database: Database) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.get("/", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const rows = await database
      .select()
      .from(trialCheckIns)
      .orderBy(desc(trialCheckIns.lastSeenAt))
      .limit(500);
    const [total] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(trialCheckIns);
    return context.json({
      installs: rows.map((row) => ({
        installId: row.installId,
        customerId: row.customerId,
        version: row.version,
        status: row.status,
        daysLeft: row.daysLeft,
        endsAt: row.endsAt?.toISOString() ?? null,
        employees: row.employees,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      })),
      total: total?.count ?? 0,
    });
  });
  return app;
}

/**
 * `/api/activation` (#109, v0.1.42): whether this install is activated, and the one box that takes a
 * trial activation code, a licence key or an unlock code. Reading is for anyone signed in, so the app
 * can show the Activate screen; typing a code is for an administrator, who on a desktop install is
 * the one person on it.
 */
export function activationRoutes(
  requireUser: Middleware,
  activation: ActivationService,
  audit?: TrialAudit,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/", async (context) =>
    context.json({ activation: await activation.current() }),
  );

  app.post("/code", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const parsed = codeBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Enter the activation code or the licence key." },
        400,
      );
    }
    try {
      const applied = await activation.apply(parsed.data.code);
      if (applied.changed) {
        await audit?.({
          eventType: "activation.code_applied",
          actorUserId: context.var.actor.id,
          payload: {
            kind: applied.kind,
            customer: applied.activation.customerId,
            state: applied.activation.state,
            until: applied.activation.until,
          },
        });
      }
      return context.json(applied);
    } catch (error) {
      if (error instanceof TrialRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  return app;
}
