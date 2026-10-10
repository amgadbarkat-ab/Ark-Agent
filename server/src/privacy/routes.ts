import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuditEventType } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { createLimiter } from "../rate-limit";
import { ErasureRefused, type ErasureDependencies, erasePerson } from "./erase";
import { exportPerson } from "./export";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

export type PrivacyAuditEvent = {
  eventType: Extract<AuditEventType, "person.exported" | "person.erased">;
  actorUserId: string;
  targetId: string;
  payload: Record<string, unknown>;
};
export type PrivacyAudit = (event: PrivacyAuditEvent) => Promise<void>;

const STATUS: Record<ErasureRefused["code"], 403 | 404 | 409 | 503> = {
  not_found: 404,
  administrator: 403,
  last_administrator: 409,
  billing: 503,
  conversations: 503,
};

const confirmBody = z.strictObject({ confirmEmail: z.string().max(320) });

type Dependencies = ErasureDependencies & { database: Database };

/** The text of an export, as a download that is sent as it is made and never held whole. */
function download(chunks: AsyncGenerator<string, void, undefined>): Response {
  const encoder = new TextEncoder();
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          // A file that stops half way is worse than one that fails: the download is cut off, so the
          // browser reports it failed, rather than keeping something that looks complete.
          controller.error(error);
        }
      },
      async cancel() {
        await chunks.return();
      },
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="ark-data-${stamp}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function refusal(
  context: { json: (body: unknown, status: number) => Response },
  error: unknown,
) {
  if (error instanceof ErasureRefused) {
    return context.json({ error: error.message }, STATUS[error.code]);
  }
  throw error;
}

/** A person's own rights over their data: to have it, and to have it removed. */
export function privacyRoutes(options: {
  requireUser: Middleware;
  dependencies: Dependencies;
  audit?: PrivacyAudit;
}) {
  const { requireUser, dependencies, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  // An export reads everything a person has; an erasure cannot be undone. Neither is a thing to do in a
  // loop, and a stolen session should not be able to do either many times over.
  const mayExport = createLimiter(5, 60 * 60_000);
  const mayErase = createLimiter(5, 60 * 60_000);

  app.get("/export", async (context) => {
    const actor = context.var.actor;
    if (!mayExport(actor.id)) {
      return context.json(
        { error: "Too many requests. Try again later." },
        429,
      );
    }
    await audit?.({
      eventType: "person.exported",
      actorUserId: actor.id,
      targetId: actor.id,
      payload: { requestedBy: "self" },
    });
    return download(exportPerson(dependencies, actor.id));
  });

  app.post("/delete", async (context) => {
    const actor = context.var.actor;
    const parsed = confirmBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (
      !parsed.success ||
      parsed.data.confirmEmail.trim().toLowerCase() !==
        actor.email.trim().toLowerCase()
    ) {
      return context.json(
        { error: "Type your email address exactly to confirm." },
        400,
      );
    }
    if (!mayErase(actor.id)) {
      return context.json(
        { error: "Too many requests. Try again later." },
        429,
      );
    }
    try {
      const result = await erasePerson(dependencies, actor.id, {
        requestedBy: "self",
      });
      await audit?.({
        eventType: "person.erased",
        actorUserId: actor.id,
        targetId: actor.id,
        payload: { requestedBy: "self", ...result },
      });
      return context.json({ ok: true, accountRemoved: result.accountRemoved });
    } catch (error) {
      return refusal(context, error);
    }
  });

  return app;
}

/**
 * Staff acting on a request somebody sent them (by email, to the address in the privacy notice): to
 * send a person what is held about them, or to remove them. Both are on the record.
 */
export function adminPrivacyRoutes(options: {
  requireUser: Middleware;
  dependencies: Dependencies;
  audit?: PrivacyAudit;
}) {
  const { requireUser, dependencies, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  async function personOf(id: string) {
    const [person] = await dependencies.database
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return person;
  }

  app.get("/:userId/export", async (context) => {
    const person = await personOf(context.req.param("userId"));
    if (!person) return context.json({ error: "No such person." }, 404);
    await audit?.({
      eventType: "person.exported",
      actorUserId: context.var.actor.id,
      targetId: person.id,
      payload: { requestedBy: "staff" },
    });
    return download(exportPerson(dependencies, person.id));
  });

  app.post("/:userId/erase", async (context) => {
    const person = await personOf(context.req.param("userId"));
    if (!person) return context.json({ error: "No such person." }, 404);
    const parsed = confirmBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (
      !parsed.success ||
      parsed.data.confirmEmail.trim().toLowerCase() !==
        person.email.trim().toLowerCase()
    ) {
      return context.json(
        { error: "Type the person's email address exactly to confirm." },
        400,
      );
    }
    try {
      const result = await erasePerson(dependencies, person.id, {
        requestedBy: "staff",
      });
      await audit?.({
        eventType: "person.erased",
        actorUserId: context.var.actor.id,
        targetId: person.id,
        payload: { requestedBy: "staff", ...result },
      });
      return context.json({ ok: true, ...result });
    } catch (error) {
      return refusal(context, error);
    }
  });

  return app;
}
