import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { isCategory } from "../../../shared/marketplace";
import type { AuditEventType } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { parsePageLimit } from "../paging";
import { createLimiter } from "../rate-limit";
import { isSecret } from "./sanitize";
import { MarketplaceError, type MarketplaceStore } from "./store";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

export type MarketplaceAuditEvent = {
  eventType: Extract<AuditEventType, `marketplace.${string}`>;
  actorUserId: string;
  /** The listing, or the report. */
  targetId: string;
  payload: Record<string, unknown>;
};
export type MarketplaceAudit = (event: MarketplaceAuditEvent) => Promise<void>;

const STATUS: Record<MarketplaceError["code"], 400 | 403 | 404 | 409 | 422> = {
  not_found: 404,
  forbidden: 403,
  view_only: 403,
  invalid: 400,
  limit: 409,
  conflict: 409,
  unclean: 422,
};

/** Bounds on what is read off the wire. The exact limits are the store's; these only stop a flood. */
const text = (max: number) => z.string().max(max);
const fields = {
  title: text(400),
  summary: text(2000),
  category: text(64),
  tags: z.array(text(200)).max(50),
  description: text(20_000),
  confirmedNoPrivateData: z.boolean(),
};
const shareBody = z.strictObject({
  agentId: z.string().min(1).max(128),
  ...fields,
});
const updateBody = z.strictObject({
  agentId: z.string().min(1).max(128).optional(),
  ...fields,
});
const publisherBody = z.strictObject({
  displayName: text(400),
  bio: text(4000).default(""),
});
const reportBody = z.strictObject({
  reason: z.string().min(1).max(64),
  details: text(5000).default(""),
});
const noteBody = z.strictObject({ note: text(2000) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;
const BODY_MAX = 64_000;

/**
 * Turn a refusal from the store into an answer. Anything that is not one of ours is a bug and is
 * left to the server's own error handling rather than dressed up as a sentence for a person.
 */
function refusal(
  context: { json: (body: unknown, status: number) => Response },
  error: unknown,
) {
  if (error instanceof MarketplaceError) {
    return context.json(
      {
        error: error.message,
        // Whether each is a secret, which can never be published, or private data, which the
        // publisher may confirm is fine. The screen shows the difference and does not decide it.
        ...(error.findings.length > 0
          ? {
              findings: error.findings.map((finding) => ({
                ...finding,
                secret: isSecret(finding.kind),
              })),
            }
          : {}),
      },
      STATUS[error.code],
    );
  }
  throw error;
}

async function readBody(context: {
  req: {
    header: (name: string) => string | undefined;
    text: () => Promise<string>;
  };
}): Promise<unknown> {
  if (Number(context.req.header("content-length") ?? 0) > BODY_MAX) {
    return undefined;
  }
  const raw = await context.req.text();
  if (raw.length > BODY_MAX) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const KINDS = new Set(["official", "shared"]);

/** What any signed-in person does with the marketplace: look, install Ark's own, share, report. */
export function marketplaceRoutes(options: {
  requireUser: Middleware;
  market: MarketplaceStore;
  audit?: MarketplaceAudit;
}) {
  const { requireUser, market, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  // A brake on the writes that cost us something to look at: sharing, editing, reporting.
  const maySubmit = createLimiter(30, 60 * 60_000);
  const mayReport = createLimiter(20, 60 * 60_000);
  const mayInstall = createLimiter(60, 60 * 60_000);

  app.get("/", async (context) => {
    const url = new URL(context.req.url);
    const parsed = parsePageLimit(url.searchParams.get("limit"), 60);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const q = url.searchParams.get("q") ?? undefined;
    if (q !== undefined && q.length > 200) {
      return context.json({ error: "Search for at most 200 characters." }, 400);
    }
    const category = url.searchParams.get("category") ?? undefined;
    if (category !== undefined && !isCategory(category)) {
      return context.json({ error: "That is not a category." }, 400);
    }
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && !KINDS.has(kind)) {
      return context.json({ error: "Kind is official or shared." }, 400);
    }
    const cursor = url.searchParams.get("cursor") ?? undefined;
    try {
      return context.json(
        await market.browse(context.var.actor, {
          ...(q ? { q } : {}),
          ...(category ? { category } : {}),
          ...(kind ? { kind: kind as "official" | "shared" } : {}),
          ...(cursor ? { cursor } : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        }),
      );
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.get("/listings/:slug", async (context) => {
    const slug = context.req.param("slug");
    if (!SLUG.test(slug)) {
      return context.json({ error: "No such listing." }, 404);
    }
    try {
      return context.json({
        listing: await market.get(context.var.actor, slug),
      });
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.post("/listings/:slug/install", async (context) => {
    const slug = context.req.param("slug");
    if (!SLUG.test(slug)) {
      return context.json({ error: "No such listing." }, 404);
    }
    if (!mayInstall(context.var.actor.id)) {
      return context.json(
        { error: "That is a lot of installs. Try again later." },
        429,
      );
    }
    try {
      const installed = await market.install(context.var.actor, slug);
      await audit?.({
        eventType: "marketplace.listing_installed",
        actorUserId: context.var.actor.id,
        targetId: installed.agentId,
        payload: { slug },
      });
      return context.json(installed, 201);
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.post("/listings/:slug/report", async (context) => {
    const slug = context.req.param("slug");
    if (!SLUG.test(slug)) {
      return context.json({ error: "No such listing." }, 404);
    }
    const parsed = reportBody.safeParse(await readBody(context));
    if (!parsed.success) {
      return context.json({ error: "Choose a reason." }, 400);
    }
    if (!mayReport(context.var.actor.id)) {
      return context.json({ error: "Too many reports. Try again later." }, 429);
    }
    try {
      await market.report(context.var.actor, slug, parsed.data);
      await audit?.({
        eventType: "marketplace.report_filed",
        actorUserId: context.var.actor.id,
        targetId: slug,
        payload: { reason: parsed.data.reason },
      });
      return context.json({ ok: true }, 201);
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.get("/publishers/:id", async (context) => {
    const id = context.req.param("id");
    if (!UUID.test(id))
      return context.json({ error: "No such publisher." }, 404);
    try {
      return context.json(await market.publisherPage(id));
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.get("/mine", async (context) => {
    return context.json(await market.mine(context.var.actor));
  });

  app.put("/mine/publisher", async (context) => {
    const parsed = publisherBody.safeParse(await readBody(context));
    if (!parsed.success) {
      return context.json({ error: "Give a name to show." }, 400);
    }
    try {
      return context.json({
        publisher: await market.savePublisher(context.var.actor, parsed.data),
      });
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.post("/mine/listings", async (context) => {
    const parsed = shareBody.safeParse(await readBody(context));
    if (!parsed.success) {
      return context.json({ error: "That listing is not complete." }, 400);
    }
    if (!maySubmit(context.var.actor.id)) {
      return context.json(
        { error: "Too many submissions. Try again later." },
        429,
      );
    }
    try {
      const listing = await market.share(context.var.actor, parsed.data);
      await audit?.({
        eventType: "marketplace.listing_submitted",
        actorUserId: context.var.actor.id,
        targetId: listing.id,
        payload: { slug: listing.slug, version: listing.version },
      });
      return context.json({ listing }, 201);
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.put("/mine/listings/:id", async (context) => {
    const id = context.req.param("id");
    if (!UUID.test(id)) return context.json({ error: "No such listing." }, 404);
    const parsed = updateBody.safeParse(await readBody(context));
    if (!parsed.success) {
      return context.json({ error: "That listing is not complete." }, 400);
    }
    if (!maySubmit(context.var.actor.id)) {
      return context.json(
        { error: "Too many submissions. Try again later." },
        429,
      );
    }
    try {
      const { agentId, ...rest } = parsed.data;
      const listing = await market.update(context.var.actor, id, {
        ...rest,
        ...(agentId ? { agentId } : {}),
      });
      await audit?.({
        eventType: "marketplace.listing_submitted",
        actorUserId: context.var.actor.id,
        targetId: listing.id,
        payload: { slug: listing.slug, version: listing.version },
      });
      return context.json({ listing });
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.delete("/mine/listings/:id", async (context) => {
    const id = context.req.param("id");
    if (!UUID.test(id)) return context.json({ error: "No such listing." }, 404);
    try {
      await market.withdraw(context.var.actor, id);
      await audit?.({
        eventType: "marketplace.listing_withdrawn",
        actorUserId: context.var.actor.id,
        targetId: id,
        payload: {},
      });
      return context.json({ ok: true });
    } catch (error) {
      return refusal(context, error);
    }
  });

  return app;
}

/** Our staff's side: what waits for review, what has been reported, and the power to act on both. */
export function adminMarketplaceRoutes(options: {
  requireUser: Middleware;
  market: MarketplaceStore;
  audit?: MarketplaceAudit;
}) {
  const { requireUser, market, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  const page = (context: { req: { url: string } }) => {
    const url = new URL(context.req.url);
    const parsed = parsePageLimit(url.searchParams.get("limit"), 60);
    if (!parsed.ok) return parsed;
    const cursor = url.searchParams.get("cursor");
    return {
      ok: true as const,
      query: {
        ...(cursor ? { cursor } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      },
    };
  };

  app.get("/pending", async (context) => {
    const parsed = page(context);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      return context.json(
        await market.pending(context.var.actor, parsed.query),
      );
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.get("/reports", async (context) => {
    const parsed = page(context);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      return context.json(
        await market.reports(context.var.actor, parsed.query),
      );
    } catch (error) {
      return refusal(context, error);
    }
  });

  app.post("/listings/:id/approve", async (context) => {
    const id = context.req.param("id");
    if (!UUID.test(id)) return context.json({ error: "No such listing." }, 404);
    try {
      await market.approve(context.var.actor, id);
      await audit?.({
        eventType: "marketplace.listing_approved",
        actorUserId: context.var.actor.id,
        targetId: id,
        payload: {},
      });
      return context.json({ ok: true });
    } catch (error) {
      return refusal(context, error);
    }
  });

  for (const [action, eventType, run] of [
    [
      "reject",
      "marketplace.listing_rejected",
      (actor: AppVariables["actor"], id: string, note: string) =>
        market.reject(actor, id, note),
    ],
    [
      "remove",
      "marketplace.listing_removed",
      (actor: AppVariables["actor"], id: string, note: string) =>
        market.remove(actor, id, note),
    ],
  ] as const) {
    app.post(`/listings/:id/${action}`, async (context) => {
      const id = context.req.param("id");
      if (!UUID.test(id)) {
        return context.json({ error: "No such listing." }, 404);
      }
      const parsed = noteBody.safeParse(await readBody(context));
      if (!parsed.success) {
        return context.json({ error: "Say why, in a sentence or two." }, 400);
      }
      try {
        await run(context.var.actor, id, parsed.data.note);
        await audit?.({
          eventType,
          actorUserId: context.var.actor.id,
          targetId: id,
          payload: { note: parsed.data.note.trim() },
        });
        return context.json({ ok: true });
      } catch (error) {
        return refusal(context, error);
      }
    });
  }

  app.post("/reports/:id/dismiss", async (context) => {
    const id = context.req.param("id");
    if (!UUID.test(id)) return context.json({ error: "No such report." }, 404);
    try {
      await market.dismissReport(context.var.actor, id);
      await audit?.({
        eventType: "marketplace.report_dismissed",
        actorUserId: context.var.actor.id,
        targetId: id,
        payload: {},
      });
      return context.json({ ok: true });
    } catch (error) {
      return refusal(context, error);
    }
  });

  return app;
}
