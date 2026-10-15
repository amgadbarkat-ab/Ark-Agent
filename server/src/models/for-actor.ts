import { encodeModelOverride } from "../../../shared/model-header";
import { providerById } from "../../../shared/model-providers";
import type { ModelForActor } from "../copilot";
import type { ModelConnectionStore } from "./connections";
import { mintModelGrant } from "./grant";
import type { ConnectionLanguageModel } from "./language-model";
import { languageModelFor } from "./language-model";
import { STARTER_CONNECTION_ID, type StarterModel } from "./starter";

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Turns a person's connections into the models their runs use: their default, and the one they
 * chose for any Bot they pointed elsewhere.
 *
 * Nobody having chosen one is not a problem. The deployment's free starter model answers when it has
 * one; otherwise the deployment's own model does, as it always has.
 * Having chosen one that cannot be used IS a problem, and is reported as one rather than worked
 * around, because the only thing to fall back to is a model somebody else is paying for.
 */
export function createModelForActor(
  store: ModelConnectionStore,
  fetchImpl: GuardedFetch,
  starter?: StarterModel,
): ModelForActor {
  const build = async (actorId: string, connectionId?: string) => {
    let opened: Awaited<ReturnType<ModelConnectionStore["open"]>>;
    try {
      opened = await store.open(actorId, connectionId);
    } catch {
      // Never the thrown value: it can carry ciphertext or connection details.
      throw new Error(
        "Your model connection could not be opened. Open Settings, then Models, and enter its key again.",
      );
    }
    if (!opened) return undefined;
    const provider = providerById(opened.providerId);
    if (!provider || provider.unavailable) {
      throw new Error(
        `Your model connection "${opened.label}" uses a provider that is no longer available. Choose another in Settings, then Models.`,
      );
    }
    return languageModelFor(
      {
        providerId: provider.id,
        protocol: provider.protocol,
        baseUrl: opened.baseUrl,
        apiKey: opened.apiKey,
        model: opened.model,
      },
      fetchImpl,
    );
  };

  return async (actorId) => {
    const choices = await store.choices(actorId);
    const connection = await build(actorId);
    // One model per distinct connection, however many Bots share it.
    const byConnection = new Map<string, ConnectionLanguageModel>();
    const forBot = new Map<string, ConnectionLanguageModel>();
    for (const [botId, connectionId] of Object.entries(choices)) {
      let model = byConnection.get(connectionId);
      if (!model) {
        model = await build(actorId, connectionId);
        if (model) byConnection.set(connectionId, model);
      }
      if (model) forBot.set(botId, model);
    }
    // Somebody who has added nothing gets the starter model, when the deployment has one. Somebody who
    // HAS added a connection never does: if theirs cannot be opened that is an error with a sentence
    // (see `build`), and quietly answering with a different model would hide it.
    const fallback =
      !connection && starter
        ? languageModelFor(
            {
              providerId: "ark-starter",
              protocol: "openai",
              baseUrl: starter.config.baseUrl,
              apiKey: null,
              model: starter.config.model,
            },
            // The starter's own fetch: it waits for a turn and adds the operator's token.
            starter.fetch,
          )
        : undefined;
    const chosen = connection ?? fallback;
    if (!chosen && forBot.size === 0) return undefined;
    return { ...(chosen ? { connection: chosen } : {}), forBot };
  };
}

/** Where the gateway answers, by dialect, as a path on this deployment. */
const GATEWAY_PATH = {
  openai: "/api/model-gateway/openai/v1",
  anthropic: "/api/model-gateway/anthropic",
} as const;

/**
 * What the deployment's own bot is told about a person's model, as a header value.
 *
 * Never the key: a grant that stands in for it, and a path on this deployment's gateway. The bot
 * calls the gateway, the gateway adds the key, and a bot that leaks everything it was told has
 * leaked something that names one connection and expires within minutes.
 *
 * Nobody having chosen is undefined, and the bot uses the deployment's own model. A choice that
 * cannot be honoured is an error with a sentence, for the reason `createModelForActor` gives.
 */
export function createModelHeaderForActor(
  store: ModelConnectionStore,
  encryptionKey: string,
  starter?: StarterModel,
): (actorId: string, botId?: string) => Promise<string | undefined> {
  return async (actorId, botId) => {
    // The connection this person chose for this Bot, else their default.
    const chosen = botId ? await store.choiceFor(actorId, botId) : undefined;
    const connection = chosen
      ? await store.get(actorId, chosen)
      : await store.getDefault(actorId);
    if (!connection) {
      // Nothing of their own: the starter model, through the gateway like any other, so the bot holds a
      // grant that names it and never the operator's token.
      if (!starter) return undefined;
      return encodeModelOverride({
        protocol: "openai",
        baseUrl: GATEWAY_PATH.openai,
        apiKey: mintModelGrant(
          { actorId, connectionId: STARTER_CONNECTION_ID },
          encryptionKey,
        ),
        model: starter.config.model,
        via: "gateway",
      });
    }
    const provider = providerById(connection.providerId);
    const protocol =
      provider?.protocol === "anthropic"
        ? "anthropic"
        : provider?.protocol === "openai"
          ? "openai"
          : undefined;
    if (!provider || provider.unavailable || !protocol) {
      throw new Error(
        `Your model connection "${connection.label}" uses a provider that is no longer available. Choose another in Settings, then Models.`,
      );
    }
    return encodeModelOverride({
      protocol,
      baseUrl: GATEWAY_PATH[protocol],
      apiKey: mintModelGrant(
        { actorId, connectionId: connection.id },
        encryptionKey,
      ),
      model: connection.model,
      via: "gateway",
    });
  };
}
