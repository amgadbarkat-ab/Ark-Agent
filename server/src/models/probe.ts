import type { ProviderDefinition } from "../../../shared/model-providers";

export type ProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: string };

type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8_000;
/** A list of models is small. Anything bigger is not one, and is not worth reading. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 500;

const ANTHROPIC_VERSION = "2023-06-01";

function endpoint(provider: ProviderDefinition, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Anthropic's address has no version in it; the others carry theirs.
  return provider.protocol === "anthropic"
    ? `${base}/v1/models`
    : `${base}/models`;
}

function headers(
  provider: ProviderDefinition,
  apiKey: string | null,
): Record<string, string> {
  const base: Record<string, string> = { accept: "application/json" };
  if (provider.protocol === "anthropic") {
    base["anthropic-version"] = ANTHROPIC_VERSION;
    if (apiKey) base["x-api-key"] = apiKey;
  } else if (apiKey) {
    base.authorization = `Bearer ${apiKey}`;
  }
  return base;
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function idsFrom(body: unknown): string[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids;
}

/** In words a person can act on, never in the provider's own error text, which may echo a key. */
function describeStatus(provider: ProviderDefinition, status: number): string {
  if (status === 401 || status === 403) {
    return `${provider.name} refused the key. Check that it is correct and still active.`;
  }
  if (status === 404) {
    return `${provider.name} did not recognise that address. Check it ends where the provider says (often /v1).`;
  }
  if (status === 429) {
    return `${provider.name} says you have used your allowance for now. Try again shortly.`;
  }
  if (status >= 500) {
    return `${provider.name} had a problem on its side (${status}). Try again shortly.`;
  }
  return `${provider.name} answered with an unexpected status (${status}).`;
}

/**
 * Asks a provider which models it offers, which doubles as the test that a connection works: the
 * address answers, and the key (if any) is accepted.
 *
 * `fetchImpl` is the guarded fetch, so an address the deployment will not contact is refused here
 * as well as where it was saved; the check is repeated at every use because a stored address can
 * start to redirect somewhere it should not.
 *
 * Nothing the provider sends back is passed on except model names.
 */
export async function probeConnection(input: {
  provider: ProviderDefinition;
  baseUrl: string;
  apiKey: string | null;
  fetchImpl: GuardedFetch;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const { provider } = input;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? TIMEOUT_MS,
  );
  try {
    const response = await input.fetchImpl(endpoint(provider, input.baseUrl), {
      method: "GET",
      headers: headers(provider, input.apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: describeStatus(provider, response.status) };
    }
    const text = await readCapped(response);
    if (text === null) {
      return {
        ok: false,
        reason: `${provider.name} sent back far more than a list of models, so it was ignored.`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: `That address answered, but not like ${provider.name}. Check the address.`,
      };
    }
    const ids = idsFrom(parsed);
    if (!ids) {
      return {
        ok: false,
        reason: `That address answered, but not with a list of models. Check the address.`,
      };
    }
    const keep = provider.modelFilter ? new RegExp(provider.modelFilter) : null;
    const models = [...new Set(keep ? ids.filter((id) => keep.test(id)) : ids)]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_MODELS);
    return { ok: true, models };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: `${provider.name} did not answer within ${Math.round((input.timeoutMs ?? TIMEOUT_MS) / 1000)} seconds.`,
      };
    }
    // The guarded fetch refuses with a sentence meant for a person. Other failures are the network.
    if (error instanceof Error && error.name === "EndpointNotAllowedError") {
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason:
        provider.tier === "local"
          ? `Could not reach ${provider.name} at ${input.baseUrl}. ${provider.name} is a program you install and start yourself on this computer, and nothing answered there. Start it, or check the address.`
          : `Could not reach ${provider.name}. Check the address, and that the server is running.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
