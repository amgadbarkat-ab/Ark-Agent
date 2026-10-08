import { providerById } from "../../../shared/model-providers";
import type { ModelForActor } from "../copilot";
import type { ModelConnectionStore } from "./connections";
import { languageModelFor } from "./language-model";

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Turns a person's default connection into the model their runs use.
 *
 * Nobody having chosen one is not a problem: the deployment's own model answers, as it always has.
 * Having chosen one that cannot be used IS a problem, and is reported as one rather than worked
 * around, because the only thing to fall back to is a model somebody else is paying for.
 */
export function createModelForActor(
  store: ModelConnectionStore,
  fetchImpl: GuardedFetch,
): ModelForActor {
  return async (actorId) => {
    let opened: Awaited<ReturnType<ModelConnectionStore["open"]>>;
    try {
      opened = await store.open(actorId);
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
}
