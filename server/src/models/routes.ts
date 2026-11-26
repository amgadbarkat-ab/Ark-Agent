import { lookup as lookupAll } from "node:dns/promises";
import { isIP } from "node:net";
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
import { isInternalAddress } from "../computer/target";
import { createLimiter } from "../rate-limit";
import {
  type ModelConnectionStore,
  TooManyConnectionsError,
} from "./connections";
import { probeConnection } from "./probe";
import { HTTPS_ONLY_FOR_SUBPROFILE } from "./public-fetch";
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

/** Long enough for a program on this computer to answer, short enough that a page never waits on one. */
const LOCAL_PROBE_MS = 2_500;

const LOCAL_FOR_SUBPROFILE =
  "A sub-profile cannot use a model on the administrator's computer or the office network. Choose a hosted provider.";

/**
 * This computer, its networks, or anywhere else that is not the public internet: the same rule the
 * guarded fetch applies to a resolved name (computer/target.ts), so the benchmarking range
 * (198.18.0.0/15), multicast, reserved space and every IPv4-mapped spelling are caught too (v0.1.57).
 */
export function isPrivateAddress(address: string): boolean {
  const plain = address.toLowerCase().replace(/^\[|\]$/g, "");
  return isIP(plain) !== 0 && isInternalAddress(plain);
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return [bare];
  const found = await lookupAll(bare, { all: true });
  return found.map((one) => one.address);
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
  /**
   * Told when a connection changes, after it has. A failure to record never fails the change: the
   * person's work is not undone because a log was unavailable. Absent records nothing.
   */
  audit?: (event: ModelAuditEvent) => Promise<void>;
  /** The deployment's free starter model, when it has one. Only described here; it is used elsewhere. */
  starter?: StarterModel;
  /**
   * Whether this person is held to public model addresses although the deployment may reach its own
   * computer and network (security review of v0.1.54, F4): a sub-profile works from another
   * computer, so "localhost" or an office address would be the administrator's computer and network.
   * The bundled model on this computer stays theirs to use through the deployment's own settings.
   */
  publicOnly?: (actor: { id: string; role: string }) => Promise<boolean>;
  /** Resolves a name to its addresses, for the check above. The tests give their own. */
  lookup?: (hostname: string) => Promise<string[]>;
  /**
   * The fetch a sub-profile's tests go through (v0.1.57, models/public-fetch.ts): public and https
   * on every hop. Absent uses `fetchImpl`.
   */
  publicFetch?: GuardedFetch;
  /**
   * The model ArkAgent runs on this computer, when the person chose it. Only asked whether it is up;
   * the run uses the deployment's own model settings, which are the same address.
   */
  offline?: { label: string; baseUrl: string; apiKey: string; model: string };
}) {
  const {
    requireUser,
    store,
    fetchImpl,
    allowPrivateHosts,
    allowedHosts,
    botVisible,
    starter,
    offline,
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
  async function checkTarget(
    providerId: string,
    baseUrl: string,
    actor: { id: string; role: string },
  ) {
    const restricted =
      allowPrivateHosts &&
      (await (options.publicOnly?.(actor) ?? Promise.resolve(false)).catch(
        () => true,
      ));
    const privateOk = allowPrivateHosts && !restricted;
    const provider = providerById(providerId);
    if (provider?.local && !privateOk) {
      return {
        ok: false as const,
        message: restricted ? LOCAL_FOR_SUBPROFILE : LOCAL_ON_HOSTED,
      };
    }
    const verdict = checkAgentEndpoint(baseUrl, {
      allowPrivateHosts: privateOk,
      ...(allowedHosts ? { allowedHosts } : {}),
    });
    if (!verdict.allowed)
      return {
        ok: false as const,
        message: restricted ? LOCAL_FOR_SUBPROFILE : verdict.reason,
      };
    if (restricted && new URL(baseUrl).protocol !== "https:")
      return { ok: false as const, message: HTTPS_ONLY_FOR_SUBPROFILE };
    if (restricted) {
      // A public name that points at this computer or its network is refused the same way.
      const lookup = options.lookup ?? defaultLookup;
      // A name that does not resolve now could be pointed here later: refused, not waved through.
      const addresses = await lookup(new URL(baseUrl).hostname).catch(
        () => [] as string[],
      );
      if (
        addresses.length === 0 ||
        addresses.some((address) => isPrivateAddress(address))
      )
        return { ok: false as const, message: LOCAL_FOR_SUBPROFILE };
    }
    return {
      ok: true as const,
      // What the test then dials through: checked again at the moment of use.
      fetch: restricted ? (options.publicFetch ?? fetchImpl) : fetchImpl,
    };
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

  /**
   * What is actually running on this computer, asked rather than assumed.
   *
   * The Models screen used to list Ollama, LM Studio and llama.cpp as "on this computer" whether or not
   * anything was running there, so choosing one was a way to meet "could not reach" for the first time.
   * Each is asked at its usual address, quickly, and the answer is what the screen shows. The model
   * ArkAgent runs itself is asked the same way and listed first, because it is the one that was
   * downloaded for this person.
   *
   * A hosted deployment has no "this computer", so it answers that nothing can be asked.
   */
  app.get("/local", async (context) => {
    if (!mayProbe(context.var.actor.id)) {
      return context.json(
        { error: "Too many tests. Wait a minute and try again." },
        429,
      );
    }
    if (!allowPrivateHosts) {
      return context.json({ offline: null, servers: [] });
    }
    const ask = (
      provider: NonNullable<ReturnType<typeof providerById>>,
      baseUrl: string,
      apiKey: string | null,
    ) =>
      probeConnection({
        provider,
        baseUrl,
        apiKey,
        fetchImpl,
        timeoutMs: LOCAL_PROBE_MS,
      });
    const [servers, own] = await Promise.all([
      Promise.all(
        PROVIDERS.filter((provider) => provider.local).map(async (provider) => {
          const result = await ask(provider, provider.baseUrl, null);
          return result.ok
            ? {
                providerId: provider.id,
                state: "running" as const,
                models: result.models.slice(0, 20),
              }
            : { providerId: provider.id, state: "stopped" as const };
        }),
      ),
      (async () => {
        const provider = providerById("llamacpp");
        if (!offline || !provider) return null;
        const result = await ask(
          provider,
          offline.baseUrl,
          offline.apiKey.trim() && offline.apiKey !== "no-key-needed"
            ? offline.apiKey
            : null,
        );
        return {
          label: offline.label,
          model: offline.model,
          state: result.ok ? ("running" as const) : ("stopped" as const),
        };
      })(),
    ]);
    return context.json({ offline: own, servers });
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
    const target = await checkTarget(
      input.providerId,
      verdict.baseUrl,
      context.var.actor,
    );
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
      const target = await checkTarget(
        current.providerId,
        verdict.baseUrl,
        context.var.actor,
      );
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

  /*
   * Back to the model that comes with the deployment. On the desktop that is the offline model,
   * which is not a connection and so had no "Make default" of its own: the first model a person
   * added became their default, and the only way back was to remove it (DT Lab, v0.1.21).
   */
  app.delete("/default", async (context) => {
    if (!store) return unavailable(context);
    const was = await store.clearDefault(context.var.actor.id);
    if (was) {
      await record({
        eventType: "model.default_changed",
        actorUserId: context.var.actor.id,
        targetId: was.id,
        payload: { providerId: null, model: null, from: was.model },
      });
    }
    return context.json({ cleared: true });
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
      return context.json({ error: "No such digital employee." }, 404);
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
    const target = await checkTarget(
      input.providerId,
      verdict.baseUrl,
      context.var.actor,
    );
    if (!target.ok) return context.json({ error: target.message }, 400);
    const provider = providerById(input.providerId);
    if (!provider) return context.json({ error: "Unknown provider." }, 400);
    return context.json(
      await probeConnection({
        provider,
        baseUrl: verdict.baseUrl,
        apiKey: input.apiKey?.trim() || null,
        fetchImpl: target.fetch,
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
    const target = await checkTarget(
      opened.providerId,
      opened.baseUrl,
      context.var.actor,
    );
    if (!target.ok) return context.json({ error: target.message }, 400);
    return context.json(
      await probeConnection({
        provider,
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        fetchImpl: target.fetch,
      }),
    );
  });

  return app;
}
