/**
 * The model a person chose for one run, built from the header the API server sent.
 *
 * Its own module for the reason `model-key.ts` is: `index.ts` calls `serve()` at module scope, so
 * importing it to reach one function binds a port.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { ModelOverride } from "../../shared/model-header";
import { apiKeyOrPlaceholder } from "./model-key";

/**
 * Whether this model must be driven through OpenAI's newer Responses API.
 *
 * Only OpenAI's own endpoint. Anything else that speaks "the OpenAI API" implements the older chat
 * endpoint, and asking one for the newer API is a request it cannot answer.
 */
function needsResponsesApi(override: ModelOverride): boolean {
  let host: string;
  try {
    host = new URL(override.baseUrl).hostname;
  } catch {
    return false;
  }
  return (
    host === "api.openai.com" && /^gpt-5\.[6-9]|^gpt-[6-9]/.test(override.model)
  );
}

/** Anthropic's SDKs add the version themselves, so the base must not already carry it. */
function anthropicRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

export function buildOverrideModel(override: ModelOverride) {
  if (override.protocol === "anthropic") {
    return new ChatAnthropic({
      model: override.model,
      apiKey: apiKeyOrPlaceholder(override.apiKey ?? undefined),
      streaming: true,
      anthropicApiUrl: anthropicRoot(override.baseUrl),
    });
  }
  return new ChatOpenAI({
    model: override.model,
    apiKey: apiKeyOrPlaceholder(override.apiKey ?? undefined),
    streaming: true,
    configuration: { baseURL: override.baseUrl.replace(/\/+$/, "") },
    ...(needsResponsesApi(override) ? { useResponsesApi: true } : {}),
  });
}

/** Which message dialect the history is written in for this run. */
export function messageProviderFor(
  override: ModelOverride | undefined,
  deploymentProvider: string,
): string {
  return override ? override.protocol : deploymentProvider;
}

/**
 * The override with its address made absolute.
 *
 * A gateway override carries a path on the deployment, because the deployment cannot know how a bot
 * reaches it but the bot does: it is the address it already uses for tool calls. Resolving against
 * that origin keeps one answer to "where is the server" instead of two settings that could disagree.
 */
export function resolveOverride(
  override: ModelOverride,
  toolUrl: string,
): ModelOverride {
  if (override.via !== "gateway") return override;
  const origin = new URL(toolUrl).origin;
  return {
    ...override,
    baseUrl: new URL(override.baseUrl, origin).href.replace(/\/+$/, ""),
  };
}
