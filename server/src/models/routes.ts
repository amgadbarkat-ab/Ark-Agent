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
import { createLimiter } from "../rate-limit";
import {
  type ModelConnectionStore,
  TooManyConnectionsError,
} from "./connections";
import { probeConnection } from "./probe";
import type { StarterModel } from "./starter";

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What a change to a person's model connections tells the audit trail. Never a key. */
export type ModelAuditEvent = {
  eventType:
    | "model.connection_added"
    | "model.connection_changed"
    | "model.connection_removed"
    | "model.default_changed"
    | "model.bot_choice_changed";
  actorUserId: string;
  targetId: string;
  payload: Record<string, unknown>;
};

/** The host of an address, which says where a key goes without saying anything that could be secret. */
function hostOf(address: string): string | null {
  try {
    return new URL(address).host;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /**
   * Told when a connection changes, after it has. A failure to record never fails the change: the
   * person's work is not undone because a log was unavailable. Absent records nothing.
   */
  audit?: (event: ModelAuditEvent) => Promise<void>;
  /** The deployment's free starter model, when it has one. Only described here; it is used elsewhere. */
  starter?: StarterModel;
}) {
  const {
    requireUser,
    store,
    fetchImpl,
    allowPrivateHosts,
    allowedHosts,
    botVisible,
    starter,
  } = options;
  const record = async (event: ModelAuditEvent) => {
    try {
      await options.audit?.(event);
    } catch {
      // See the option.
    }
  };
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

  /**
   * Whether this deployment offers the free starter model, and how busy it is, so the Models screen
   * can say "free, slow, two ahead of you" instead of leaving a person watching a spinner.
   * Says nothing about the address or the token: those are the operator's.
   */
  app.get("/starter", async (context) => {
    if (!starter) return context.json({ configured: false });
    const state = await starter.health();
    return context.json({
      configured: true,
      state,
      ...starter.status(),
      maxWaitSeconds: Math.round(starter.config.maxWaitMs / 1000),
    });
  });

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
      await record({
        eventType: "model.connection_added",
        actorUserId: context.var.actor.id,
        targetId: connection.id,
        payload: {
          providerId: connection.providerId,
          label: connection.label,
          model: connection.model,
          host: hostOf(connection.baseUrl),
          keySet: Boolean(input.apiKey),
        },
      });
      return context.json({ connection }, 201);
    } catch (error) {
      if (error instanceof TooManyConnectionsError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  /*
   * A connection's id is a UUID, and the database refuses anything else with an error this route
   * would not catch. So a person who sends `x`, or a NUL, got a server error where "no such
   * connection" is the answer. Said once, before any of the routes below, not once in each.
   */
  const validConnectionId: MiddlewareHandler = async (context, next) => {
    if (!UUID.test(context.req.param("id") ?? "")) {
      return context.json({ error: "No such connection." }, 404);
    }
    return next();
  };
  app.use("/connections/:id", validConnectionId);
  app.use("/connections/:id/*", validConnectionId);

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
    if (!updated) return context.json({ error: "No such connection." }, 404);
    await record({
      eventType: "model.connection_changed",
      actorUserId: userId,
      targetId: updated.id,
      payload: {
        providerId: updated.providerId,
        // Which things were changed, and for the ones that are not secret, from what to what.
        changed: Object.keys(patch).sort(),
        ...(patch.model !== undefined
          ? { model: { from: current.model, to: updated.model } }
          : {}),
        ...(baseUrl !== undefined
          ? {
              host: {
                from: hostOf(current.baseUrl),
                to: hostOf(updated.baseUrl),
              },
            }
          : {}),
        ...(patch.apiKey !== undefined
          ? { key: patch.apiKey ? "replaced" : "removed" }
          : {}),
      },
    });
    return context.json({ connection: updated });
  });

  app.delete("/connections/:id", async (context) => {
    if (!store) return unavailable(context);
    const userId = context.var.actor.id;
    const id = context.req.param("id");
    // Read before it is gone, so the trail can say what was removed.
    const before = await store.get(userId, id);
    const removed = await store.remove(userId, id);
    if (!removed) return context.json({ error: "No such connection." }, 404);
    await record({
      eventType: "model.connection_removed",
      actorUserId: userId,
      targetId: id,
      payload: {
        providerId: before?.providerId ?? null,
        label: before?.label ?? null,
        host: before ? hostOf(before.baseUrl) : null,
      },
    });
    return context.json({ removed: true });
  });

  app.post("/connections/:id/default", async (context) => {
    if (!store) return unavailable(context);
    const connection = await store.setDefault(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!connection) {
      return context.json({ error: "No such connection." }, 404);
    }
    await record({
      eventType: "model.default_changed",
      actorUserId: context.var.actor.id,
      targetId: connection.id,
      payload: {
        providerId: connection.providerId,
        model: connection.model,
      },
    });
    return context.json({ connection });
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
    if (!done) return context.json({ error: "No such connection." }, 404);
    await record({
      eventType: "model.bot_choice_changed",
      actorUserId: actor.id,
      targetId: botId,
      payload: { connectionId: parsed.data.connectionId },
    });
    return context.json({ botId, connectionId: parsed.data.connectionId });
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
