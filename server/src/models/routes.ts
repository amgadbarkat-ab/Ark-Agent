import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  checkConnectionInput,
  LOCAL_MODELS,
  PROVIDERS,
  providerById,
} from "../../../shared/model-providers";
import { checkAgentEndpoint } from "../agents/endpoint";
import type { AppVariables } from "../auth/guards";
import {
  type ModelConnectionStore,
  TooManyConnectionsError,
} from "./connections";
import { probeConnection } from "./probe";

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

const label = z.string().trim().min(1).max(80);
const model = z.string().trim().min(1).max(200);
const key = z.string().max(4096);
const address = z.string().max(2048);

const createBody = z.strictObject({
  providerId: z.string().min(1).max(64),
  label: label.optional(),
  baseUrl: address.optional(),
  apiKey: key.nullish(),
  model,
});
const patchBody = z.strictObject({
  label: label.optional(),
  baseUrl: address.optional(),
  apiKey: key.nullable().optional(),
  model: model.optional(),
});
const botChoiceBody = z.strictObject({
  /** A connection of the person's own, or null to go back to their default. */
  connectionId: z.uuid().nullable(),
});
const probeBody = z.strictObject({
  providerId: z.string().min(1).max(64),
  baseUrl: address.optional(),
  apiKey: key.nullish(),
});

/** A fixed window per person: enough to try a few providers, little enough to be no scanner. */
function createLimiter(limit: number, windowMs: number) {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (who: string, now = Date.now()) => {
    const entry = seen.get(who);
    if (!entry || entry.resetAt <= now) {
      seen.set(who, { count: 1, resetAt: now + windowMs });
      if (seen.size > 10_000) {
        for (const [name, value] of seen) {
          if (value.resetAt <= now) seen.delete(name);
        }
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

const LOCAL_ON_HOSTED =
  "This server cannot reach models on your own computer. Use the Ark desktop app for local models, or choose a hosted provider.";

export function modelConnectionRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  store?: ModelConnectionStore;
  /** The guarded fetch every model request goes through. */
  fetchImpl: GuardedFetch;
  /** Whether this deployment may contact the machine it runs on and its own network. */
  allowPrivateHosts: boolean;
  allowedHosts?: ReadonlySet<string>;
  /**
   * Whether this person may see, and so may choose a model for, one Bot. The same roster that
   * decides what they can talk to. Absent means no Bot can be chosen for.
   */
  botVisible?: (
    actor: { id: string; role: string },
    botId: string,
  ) => Promise<boolean>;
}) {
  const {
    requireUser,
    store,
    fetchImpl,
    allowPrivateHosts,
    allowedHosts,
    botVisible,
  } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  const mayProbe = createLimiter(30, 60_000);
  app.use("*", requireUser);

  const unavailable = (context: { json: (b: unknown, s: 503) => Response }) =>
    context.json({ error: "Model connections are not available." }, 503);

  /**
   * An address this deployment is willing to contact for this provider, or the sentence saying why
   * not. A local server on a hosted deployment is refused by name, not left to fail as an
   * unreachable address, because "localhost" there is the datacentre and the person would
   * otherwise be told only that nothing answered.
   */
  function checkTarget(providerId: string, baseUrl: string) {
    const provider = providerById(providerId);
    if (provider?.local && !allowPrivateHosts) {
      return { ok: false as const, message: LOCAL_ON_HOSTED };
    }
    const verdict = checkAgentEndpoint(baseUrl, {
      allowPrivateHosts,
      ...(allowedHosts ? { allowedHosts } : {}),
    });
    return verdict.allowed
      ? { ok: true as const }
      : { ok: false as const, message: verdict.reason };
  }

  // What the picker shows. Local providers are marked unusable on a hosted deployment, so the app
  // can say why instead of letting someone fill in a form that can never work.
  app.get("/providers", (context) =>
    context.json({
      providers: PROVIDERS.map((provider) => ({
        ...provider,
        unavailable:
          provider.unavailable ??
          (provider.local && !allowPrivateHosts ? LOCAL_ON_HOSTED : undefined),
      })),
      localModels: LOCAL_MODELS,
    }),
  );

  app.get("/connections", async (context) => {
    if (!store) return unavailable(context);
    return context.json({
      connections: await store.list(context.var.actor.id),
    });
  });

  app.post("/connections", async (context) => {
    if (!store) return unavailable(context);
    const parsed = createBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json({ error: "Choose a provider and a model." }, 400);
    }
    const input = parsed.data;
    const verdict = checkConnectionInput(input);
    if (!verdict.ok) return context.json({ error: verdict.message }, 400);
    const target = checkTarget(input.providerId, verdict.baseUrl);
    if (!target.ok) return context.json({ error: target.message }, 400);

    const provider = providerById(input.providerId);
    try {
      const connection = await store.create(context.var.actor.id, {
        providerId: input.providerId,
        label: input.label ?? provider?.name ?? input.providerId,
        baseUrl: verdict.baseUrl,
        model: input.model,
        apiKey: input.apiKey ?? null,
      });
      return context.json({ connection }, 201);
    } catch (error) {
      if (error instanceof TooManyConnectionsError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.patch("/connections/:id", async (context) => {
    if (!store) return unavailable(context);
    const userId = context.var.actor.id;
    const parsed = patchBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json({ error: "Those changes are not valid." }, 400);
    }
    const current = await store.get(userId, context.req.param("id"));
    if (!current) return context.json({ error: "No such connection." }, 404);
    const patch = parsed.data;
    const provider = providerById(current.providerId);

    let baseUrl: string | undefined;
    if (patch.baseUrl !== undefined) {
      const verdict = checkConnectionInput({
        providerId: current.providerId,
        baseUrl: patch.baseUrl,
        // Only the address is being checked here, and a key is not required to change one.
        apiKey: "present",
      });
      if (!verdict.ok) return context.json({ error: verdict.message }, 400);
      const target = checkTarget(current.providerId, verdict.baseUrl);
      if (!target.ok) return context.json({ error: target.message }, 400);
      baseUrl = verdict.baseUrl;
    }
    if (patch.apiKey === null || patch.apiKey === "") {
      if (provider?.keyRequired) {
        return context.json(
          {
            error: `${provider.name} needs an API key, so it cannot be removed.`,
          },
          400,
        );
      }
    }
    const updated = await store.update(userId, current.id, {
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey || null } : {}),
    });
    return updated
      ? context.json({ connection: updated })
      : context.json({ error: "No such connection." }, 404);
  });

  app.delete("/connections/:id", async (context) => {
    if (!store) return unavailable(context);
    const removed = await store.remove(
      context.var.actor.id,
      context.req.param("id"),
    );
    return removed
      ? context.json({ removed: true })
      : context.json({ error: "No such connection." }, 404);
  });

  app.post("/connections/:id/default", async (context) => {
    if (!store) return unavailable(context);
    const connection = await store.setDefault(
      context.var.actor.id,
      context.req.param("id"),
    );
    return connection
      ? context.json({ connection })
      : context.json({ error: "No such connection." }, 404);
  });

  // Which Bot thinks with which of the person's connections, where it is not their default.
  app.get("/bots", async (context) => {
    if (!store) return unavailable(context);
    const choices = await store.choices(context.var.actor.id);
    return context.json({
      choices: Object.entries(choices).map(([botId, connectionId]) => ({
        botId,
        connectionId,
      })),
    });
  });

  app.put("/bots/:botId", async (context) => {
    if (!store || !botVisible) return unavailable(context);
    const parsed = botChoiceBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Choose one of your models, or the default." },
        400,
      );
    }
    const botId = context.req.param("botId");
    const actor = context.var.actor;
    if (!(await botVisible(actor, botId))) {
      return context.json({ error: "No such coworker." }, 404);
    }
    const done = await store.setChoice(
      actor.id,
      botId,
      parsed.data.connectionId,
    );
    return done
      ? context.json({ botId, connectionId: parsed.data.connectionId })
      : context.json({ error: "No such connection." }, 404);
  });

  // Test something before saving it. The key travels in the body, is used once, and is not kept.
  app.post("/probe", async (context) => {
    if (!mayProbe(context.var.actor.id)) {
      return context.json(
        { error: "Too many tests. Wait a minute and try again." },
        429,
      );
    }
    const parsed = probeBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return context.json({ error: "Choose a provider to test." }, 400);
    const input = parsed.data;
    const verdict = checkConnectionInput(input);
    if (!verdict.ok) return context.json({ error: verdict.message }, 400);
    const target = checkTarget(input.providerId, verdict.baseUrl);
    if (!target.ok) return context.json({ error: target.message }, 400);
    const provider = providerById(input.providerId);
    if (!provider) return context.json({ error: "Unknown provider." }, 400);
    return context.json(
      await probeConnection({
        provider,
        baseUrl: verdict.baseUrl,
        apiKey: input.apiKey?.trim() || null,
        fetchImpl,
      }),
    );
  });

  // Test one that is already saved, with the key it holds.
  app.post("/connections/:id/probe", async (context) => {
    if (!store) return unavailable(context);
    if (!mayProbe(context.var.actor.id)) {
      return context.json(
        { error: "Too many tests. Wait a minute and try again." },
        429,
      );
    }
    const opened = await store.open(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!opened) return context.json({ error: "No such connection." }, 404);
    const provider = providerById(opened.providerId);
    if (!provider) return context.json({ error: "Unknown provider." }, 400);
    const target = checkTarget(opened.providerId, opened.baseUrl);
    if (!target.ok) return context.json({ error: target.message }, 400);
    return context.json(
      await probeConnection({
        provider,
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        fetchImpl,
      }),
    );
  });

  return app;
}
