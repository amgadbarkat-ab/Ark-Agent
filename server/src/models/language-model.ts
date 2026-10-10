import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { BuiltInAgentClassicConfig } from "@copilotkit/runtime/v2";
import type { ProviderProtocol } from "../../../shared/model-providers";

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The model object a built-in agent runs on, in the shape the runtime we ship accepts. */
export type ConnectionLanguageModel = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;

/**
 * What a run needs to talk to the model a person chose: which dialect, where, as whom, and which
 * model. Holds a key, so it lives only in server memory for the length of a request.
 */
export type ModelChoice = {
  providerId: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

/** Without a key an SDK refuses to build a client, though a local server never reads one. */
const NO_KEY = "no-key-needed";

/** The SDKs call `fetch(input, init)`; ours is `(url, init)` and does its own address checks. */
function guarded(fetchImpl: GuardedFetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return fetchImpl(url, init);
  }) as typeof fetch;
}

/** Anthropic's SDK appends only the path after the version, so the version has to be in the base. */
function anthropicBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/**
 * Builds the model for a run from a person's connection.
 *
 * Every request the model makes goes through `fetchImpl`, which re-checks the address (and every
 * redirect) at the moment of use. An address that was acceptable when it was saved is not trusted to
 * still be.
 */
export function languageModelFor(
  choice: ModelChoice,
  fetchImpl: GuardedFetch,
): ConnectionLanguageModel {
  const fetch = guarded(fetchImpl);

  if (choice.protocol === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: choice.apiKey ?? NO_KEY,
      baseURL: anthropicBase(choice.baseUrl),
      fetch,
    });
    return anthropic(choice.model) as ConnectionLanguageModel;
  }

  const openai = createOpenAI({
    apiKey: choice.apiKey ?? NO_KEY,
    baseURL: choice.baseUrl.replace(/\/+$/, ""),
    fetch,
  });
  // OpenAI itself is driven through its newer API, as the built-in default is. Everything else that
  // says it is "OpenAI-compatible" has the older chat endpoint, which is the one they all implement.
  const model =
    choice.providerId === "openai"
      ? openai(choice.model)
      : openai.chat(choice.model);
  return model as ConnectionLanguageModel;
}
