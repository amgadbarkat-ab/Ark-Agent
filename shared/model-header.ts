/**
 * How the API server tells the deployment's own bot which model a person chose, for one run.
 *
 * A header rather than a field in the body: the body is the AG-UI input, which the conversation
 * stores and shows back, and a key must never be in anything that is stored. The header exists for
 * the length of one request, between two processes this deployment runs, and only ever goes to an
 * endpoint the deployment itself owns (see `createRuntimeAgentLoader`).
 *
 * Both sides import this file, so what one writes is exactly what the other accepts.
 */

export const MODEL_HEADER = "x-ark-model";

/**
 * Only the two dialects the bot can speak. Anything else is turned into one of these upstream.
 *
 * `via: "gateway"` is how a deployment keeps a person's key to itself: the bot is given a path on
 * the deployment's own model gateway (resolved against the address the bot already uses to reach
 * the deployment) and a grant in place of a key, and the gateway adds the real key on the way
 * out. Without it, `baseUrl` is an address the bot calls directly.
 */
export type ModelOverride = {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  /** Null for a server that needs no key. With `via`, the grant that stands in for one. */
  apiKey: string | null;
  model: string;
  via?: "gateway";
};

/** A key, an address and a model name are small. A header bigger than this is not one of ours. */
const MAX_ENCODED_LENGTH = 8 * 1024;

export function encodeModelOverride(override: ModelOverride): string {
  return Buffer.from(JSON.stringify(override), "utf8").toString("base64url");
}

/**
 * The override a header carries, or undefined for anything absent or malformed.
 *
 * Undefined, not an error: a bot that cannot read the header runs on the model it was started with,
 * and the server, which wrote the header, is the side that decides whether that is acceptable.
 */
export function decodeModelOverride(
  value: string | null | undefined,
): ModelOverride | undefined {
  if (!value || value.length > MAX_ENCODED_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { protocol, baseUrl, apiKey, model, via } = parsed as Record<
    string,
    unknown
  >;
  if (protocol !== "openai" && protocol !== "anthropic") return undefined;
  if (typeof baseUrl !== "string" || !baseUrl) return undefined;
  if (typeof model !== "string" || !model) return undefined;
  if (apiKey !== null && typeof apiKey !== "string") return undefined;
  if (via !== undefined && via !== "gateway") return undefined;
  if (via === "gateway") {
    // A path on the deployment, never an address: `//host` would be one in disguise.
    if (!baseUrl.startsWith("/") || baseUrl.startsWith("//")) return undefined;
    if (!apiKey) return undefined;
    return { protocol, baseUrl, apiKey, model, via };
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { protocol, baseUrl, apiKey, model };
}
