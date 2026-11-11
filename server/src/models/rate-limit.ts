/**
 * A model provider's per-minute limits, met without a person seeing a raw 429 (desk #83).
 *
 * DT Lab, v0.1.31, Inception · Mercury 3: a long Greek prompt, and then a one-line one, both ended
 * with "429 Rate limit reached: output token limit exceeded" and no reply. Inception's free tier
 * allows 100,000 output tokens a minute, and ArkAgent asked for no `max_tokens` at all, so each call
 * was free to claim the provider's whole default output, and the handful of calls one turn makes
 * (routing, tool steps, the title) used the minute up between them.
 *
 * Three things, at the one place every request to such a provider passes through:
 *  1. CAP: a request that names no output limit is given one, and one that names a larger one is
 *     brought down to it. Only for providers listed below, and with room for a long answer.
 *  2. WAIT: a 429 is retried, after the time the provider asks for (`Retry-After`) or a short
 *     backoff, a couple of times and never for long: a person is watching.
 *  3. SAY: when the provider still refuses, the refusal the conversation receives is a sentence
 *     a person can act on, not the provider's own words.
 */

/** Hosts whose per-minute output limit a turn can reach, and the most output one call may ask for. */
const OUTPUT_CAPS = new Map<string, number>([["api.inceptionlabs.ai", 8192]]);

/** How many times a 429 is retried, and the longest any one wait may be. */
const RETRIES = 2;
const LONGEST_WAIT_MS = 20_000;
const BACKOFF_MS = [2_000, 6_000];

export const RATE_LIMITED_SENTENCE =
  "The model's per-minute limit was reached, so this reply could not be written. Wait a minute and send it again, or choose another model under Settings, then Models.";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The output cap for this address, or undefined when it has none. */
export function outputCapFor(url: string): number | undefined {
  return OUTPUT_CAPS.get(hostOf(url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LIMIT_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
] as const;

/**
 * The request body with its output limit brought within `cap`. Unchanged (the same string) when it
 * is not a JSON object, or already asks for no more than `cap`.
 */
export function capOutput(body: string, cap: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) return body;
  const named = LIMIT_FIELDS.filter((field) => field in parsed);
  if (named.length === 0) {
    // The Responses API names its limit differently from chat completions.
    const field =
      "input" in parsed && !("messages" in parsed)
        ? "max_output_tokens"
        : "max_tokens";
    return JSON.stringify({ ...parsed, [field]: cap });
  }
  let changed = false;
  const next: Record<string, unknown> = { ...parsed };
  for (const field of named) {
    const value = parsed[field];
    if (typeof value !== "number" || value > cap) {
      next[field] = cap;
      changed = true;
    }
  }
  return changed ? JSON.stringify(next) : body;
}

/** How long a 429 asks to be left alone, in milliseconds, within the longest wait allowed. */
export function waitFor(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, LONGEST_WAIT_MS);
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 2_000;
}

function rateLimited(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: RATE_LIMITED_SENTENCE,
        type: "rate_limit_exceeded",
        code: "rate_limit_exceeded",
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

type Send = (body: string) => Promise<Response>;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Send `body` to `url` within the provider's limits: capped, retried on a 429, and refused in a
 * sentence when the provider keeps refusing. Addresses with no cap are passed through untouched.
 */
export async function sendWithModelLimits(
  url: string,
  body: string,
  send: Send,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Response> {
  const cap = outputCapFor(url);
  if (cap === undefined) return send(body);
  const capped = capOutput(body, cap);
  for (let attempt = 0; ; attempt++) {
    const response = await send(capped);
    if (response.status !== 429) return response;
    if (attempt >= RETRIES) {
      await response.body?.cancel().catch(() => {});
      return rateLimited();
    }
    const ms = waitFor(response, attempt);
    await response.body?.cancel().catch(() => {});
    await wait(ms);
  }
}

/** A `fetch` that does the above for every request whose body is a string, which is how SDKs send. */
export function fetchWithModelLimits(inner: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!init || typeof init.body !== "string") return inner(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (outputCapFor(url) === undefined) return inner(input, init);
    return sendWithModelLimits(url, init.body, (body) =>
      inner(input, { ...init, body }),
    );
  }) as typeof fetch;
}
