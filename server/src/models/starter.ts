/**
 * The Ark starter model: one small free model that a person with no model of their own can use at once.
 *
 * WHY IT EXISTS. A new person who has not added an API key gets "open Settings, then Models" on their
 * first message, and for most people that is where the first five minutes end. The starter model is a
 * model this deployment hosts itself on hardware that costs nothing per request, so the first answer
 * needs nothing from the person.
 *
 * WHAT IT IS NOT. It is not a plan, a quota or a bill. It has no usage count, no daily allowance and
 * no price, because there is nothing it costs per request. What it does have is a limit that cannot
 * be argued with: a small server answers one or two people at a time. So requests wait their turn,
 * in order, and a request that would wait too long is turned away with a sentence, rather than left
 * hanging until some other timeout fires with a worse one. That is a capacity rule, not a usage rule.
 *
 * WHERE IT RUNS. Anywhere that speaks the OpenAI chat API: for the first deployment a llama.cpp
 * server on an Oracle Cloud Always Free Arm machine (docs/ark/22-starter-model.md). The address is
 * the operator's, set in configuration. It is never a person's input, so it does not go through the
 * guard that keeps people's own addresses away from internal networks; that guard exists for
 * addresses somebody typed, and this one nobody typed.
 *
 * THE SLOT. A reply is a stream, so a request holds its place until the stream has ended, been
 * cancelled or failed, not merely until the first byte arrives. Holding it only to the first byte
 * would let a whole queue of people start streaming at once into a server that can only do one.
 */

/** The reserved connection id a grant names when the model is the starter and not a person's own. */
export const STARTER_CONNECTION_ID = "ark-starter";

/** What the people who set the deployment up decide. */
export type StarterModelConfig = {
  /** The OpenAI-compatible base address, ending in /v1. */
  baseUrl: string;
  /** A bearer token the server expects, when it expects one. Never sent to a browser or a bot. */
  token: string | undefined;
  /** The model name the server serves. */
  model: string;
  /** How many requests the server may answer at the same moment. One, for a two-core machine. */
  concurrency: number;
  /** The longest a request waits for its turn before it is turned away. */
  maxWaitMs: number;
};

export type StarterStatus = {
  model: string;
  /** Requests being answered right now. */
  active: number;
  /** Requests waiting for a turn. */
  waiting: number;
  concurrency: number;
};

/** The state of the server itself, from asking it. */
export type StarterHealth = "ready" | "down";

/** Raised when a request waited its whole allowance and never got a turn. */
export class StarterBusyError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(
      "The starter model is busy right now. Try again in a minute, or add your own model in Settings, then Models.",
    );
    this.name = "StarterBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type StarterModel = {
  readonly config: StarterModelConfig;
  /**
   * A fetch for the starter server: waits for a turn, adds the token, and keeps the turn until the
   * answer has finished streaming. Throws {@link StarterBusyError} if no turn comes in time.
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  status: () => StarterStatus;
  /** Whether the server answers. Cached briefly so a screen polling it is not a probe of the server. */
  health: () => Promise<StarterHealth>;
};

type Waiter = {
  grant: () => void;
  abandon: (reason: Error) => void;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const HEALTH_TTL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 4_000;

export function createStarterModel(
  config: StarterModelConfig,
  options: { fetchImpl?: FetchLike; now?: () => number } = {},
): StarterModel {
  const send: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const base = config.baseUrl.replace(/\/+$/, "");

  let active = 0;
  const queue: Waiter[] = [];

  /** A turn, or a StarterBusyError, or the caller's own abort. Returns the function that gives it back. */
  function acquire(
    signal: AbortSignal | null | undefined,
  ): Promise<() => void> {
    const giveBack = () => {
      let given = false;
      return () => {
        if (given) return;
        given = true;
        active -= 1;
        const next = queue.shift();
        if (next) next.grant();
      };
    };

    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (active < config.concurrency && queue.length === 0) {
      active += 1;
      return Promise.resolve(giveBack());
    }

    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        grant: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          active += 1;
          resolve(giveBack());
        },
        abandon: (reason) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const leave = () => {
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
      };
      const onAbort = () => {
        leave();
        waiter.abandon(abortError(signal));
      };
      timer = setTimeout(() => {
        leave();
        waiter.abandon(
          new StarterBusyError(
            Math.max(10, Math.ceil(config.maxWaitMs / 2000)),
          ),
        );
      }, config.maxWaitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }

  const starterFetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    // The server's own token goes on here and only here. What the caller sent, a grant, goes no further.
    headers.delete("authorization");
    if (config.token) headers.set("authorization", `Bearer ${config.token}`);
    // Asking which models exist is not generating anything, so it does not wait behind somebody's answer.
    if ((init?.method ?? "GET").toUpperCase() === "GET") {
      return send(url, { ...init, headers });
    }
    const release = await acquire(init?.signal);
    let response: Response;
    try {
      response = await send(url, { ...init, headers });
    } catch (error) {
      release();
      throw error;
    }
    if (!response.body) {
      release();
      return response;
    }
    return new Response(holdUntilDone(response.body, release), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  let cachedHealth: { at: number; value: StarterHealth } | undefined;
  let probing: Promise<StarterHealth> | undefined;

  async function health(): Promise<StarterHealth> {
    if (cachedHealth && now() - cachedHealth.at < HEALTH_TTL_MS) {
      return cachedHealth.value;
    }
    // One probe at a time, however many screens ask.
    probing ??= (async () => {
      let value: StarterHealth = "down";
      try {
        const headers = new Headers();
        if (config.token)
          headers.set("authorization", `Bearer ${config.token}`);
        const response = await send(`${base}/models`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        // Only the status matters, and a body left unread holds a connection open.
        await response.body?.cancel();
        value = response.ok ? "ready" : "down";
      } catch {
        value = "down";
      }
      cachedHealth = { at: now(), value };
      return value;
    })().finally(() => {
      probing = undefined;
    });
    return probing;
  }

  return {
    config,
    fetch: starterFetch,
    status: () => ({
      model: config.model,
      active,
      waiting: queue.length,
      concurrency: config.concurrency,
    }),
    health,
  };
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("This operation was aborted", "AbortError");
}

/**
 * The answer's body, unchanged, that gives the turn back when it is done with.
 *
 * "Done with" is the three ways a stream ends: it is read to the end, the reader walks away, or it
 * fails. Each releases once; the release itself is idempotent, so a cancel that races a final read is
 * harmless.
 */
function holdUntilDone(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}
