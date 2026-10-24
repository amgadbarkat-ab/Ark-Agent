import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { BuiltInAgentClassicConfig } from "@copilotkit/runtime/v2";
import type { ProviderProtocol } from "../../../shared/model-providers";
import { requestWithSingleTypes } from "../../../shared/tool-schema";

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

/**
 * A fetch that hands a model on this computer tool schemas its chat template can read; see
 * `shared/tool-schema.ts`. Only a request body that is a string is touched, which is how the SDK
 * sends one.
 */
function forLocalTemplate(inner: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    inner(
      input,
      init && typeof init.body === "string"
        ? { ...init, body: requestWithSingleTypes(init.body) }
        : init,
    )) as typeof fetch;
}

/** The connections that are a model server on somebody's own machine. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp"]);

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
    fetch: LOCAL_PROVIDERS.has(choice.providerId)
      ? forLocalTemplate(fetch)
      : fetch,
  });
  // OpenAI itself is driven through its newer API, as the built-in default is. Everything else that
  // says it is "OpenAI-compatible" has the older chat endpoint, which is the one they all implement.
  const model =
    choice.providerId === "openai"
      ? openai(choice.model)
      : openai.chat(choice.model);
  return model as ConnectionLanguageModel;
}

/**
 * The deployment's own model, when it is a server that only speaks the older chat API.
 *
 * A built-in digital employee is handed the model as `openai/<name>`, which the runtime drives through
 * OpenAI's newer Responses API, at whatever `OPENAI_BASE_URL` names. On the desktop that is the model
 * on this computer, and llama.cpp's `/v1/responses` stream leaves out a field the SDK needs, so every
 * chat with a built-in employee failed ("text part … not found", and "NotImplemented" before that).
 * Everything that says it is OpenAI-compatible implements `/v1/chat/completions`, so that is what a
 * base URL other than OpenAI's own is given, exactly as a person's own connection already is.
 *
 * Undefined means "use the string the runtime resolves itself", which is unchanged for OpenAI.
 */
export function deploymentChatModel(
  provider: string,
  model: string,
  environment: Record<string, string | undefined> = process.env,
): ConnectionLanguageModel | undefined {
  if (provider !== "openai") return undefined;
  const baseUrl = environment.OPENAI_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (host === "api.openai.com") return undefined;
  const key = `${baseUrl}\n${model}\n${environment.BOT_CONTEXT_TOKENS ?? ""}`;
  const cached = deploymentModels.get(key);
  if (cached) return cached;
  // The desktop writes the window only for the model it runs itself, which is the one whose chat
  // template cannot read a list of types.
  const local = Boolean(environment.BOT_CONTEXT_TOKENS?.trim());
  const built = createOpenAI({
    apiKey: environment.OPENAI_API_KEY?.trim() || NO_KEY,
    baseURL: baseUrl.replace(/\/+$/, ""),
    ...(local ? { fetch: forLocalTemplate(globalThis.fetch) } : {}),
  }).chat(model) as ConnectionLanguageModel;
  deploymentModels.set(key, built);
  return built;
}

const deploymentModels = new Map<string, ConnectionLanguageModel>();
