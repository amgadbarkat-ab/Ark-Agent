import { count, gt, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { collectProcessMetrics, Registry } from "../../shared/metrics";
import type { AppVariables } from "./auth/guards";
import type { Database } from "./db/client";
import { cloudCharges, runSlots, subscriptions } from "./db/schema";

/**
 * What the server says about itself: a line for a request that went wrong or took long, numbers about
 * every request, and a few counts of what the business is doing.
 *
 * NOTHING IN HERE IS ABOUT A PERSON. A request is described by its method, the route pattern that
 * matched (`/api/agents/:id`, never the path with the id in it), its status and how long it took. No
 * query string, header, body, address, user or account id, and no error message: messages from the
 * database carry the values that failed (an email in a duplicate-key error), so only an error's name
 * and code are kept. The request id is random and is how a person's report ("it failed at 14:02,
 * request abc") is matched to a line.
 */

export type RequestLogMode = "errors" | "all" | "off";

export function parseRequestLogMode(value: string | undefined): RequestLogMode {
  const mode = value?.trim().toLowerCase();
  if (mode === undefined || mode === "" || mode === "errors") return "errors";
  if (mode === "all" || mode === "off") return mode;
  throw new Error(
    `REQUEST_LOG must be "errors", "all" or "off" (it is "${mode}").`,
  );
}

/** The one registry the server records into and the metrics listener serves. */
export const serverMetrics = new Registry();
collectProcessMetrics(serverMetrics);

const requests = serverMetrics.counter(
  "ark_http_requests_total",
  "Requests answered, by method, the route pattern that matched, and status.",
  ["method", "route", "status"],
);
const durations = serverMetrics.histogram(
  "ark_http_request_duration_seconds",
  "How long requests took, by method and the route pattern that matched.",
  ["method", "route"],
);
const inFlight = serverMetrics.gauge(
  "ark_http_requests_in_flight",
  "Requests being answered now.",
);
let inFlightNow = 0;
serverMetrics.collect(() => inFlight.set(inFlightNow));

/** A request that takes this long is logged even when nothing went wrong. */
export const SLOW_REQUEST_MS = 3000;

/**
 * The route pattern a request matched, from what was registered rather than from what was asked.
 * Anything that matched only a catch-all is one label ("static" for pages, "unmatched" under /api),
 * so a scanner asking for a million paths is one series.
 */
export function routeLabel(
  context: Context<{ Variables: AppVariables }>,
): string {
  const matched = context.req.routePath;
  if (matched && matched !== "*" && matched !== "/*") return matched;
  return context.req.path.startsWith("/api") ? "unmatched" : "static";
}

/** What can be said about an error without saying what was in it. */
export function describeError(error: unknown): {
  error: string;
  code?: string;
  at?: string;
} {
  if (!(error instanceof Error)) return { error: typeof error };
  const code = (error as { code?: unknown }).code;
  // The first stack frame that is in our code: where to look, not what the data was.
  const frame = error.stack
    ?.split("\n")
    .find((line) => line.includes("/server/src/") || line.includes("/hub/src/"))
    ?.trim()
    .replace(/^at /, "")
    .replace(/^.*\((.*)\)$/, "$1")
    .replace(/^.*?(\/(?:server|hub)\/src\/)/, "$1");
  return {
    error: error.name,
    ...(typeof code === "string" ? { code } : {}),
    ...(frame ? { at: frame } : {}),
  };
}

export function requestObservability(options: {
  mode: RequestLogMode;
  metrics?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}): MiddlewareHandler<{ Variables: AppVariables }> {
  const log = options.log ?? ((line) => console.log(line));
  const now = options.now ?? (() => performance.now());
  return async (context, next) => {
    const id = crypto.randomUUID();
    context.set("requestId", id);
    context.header("x-request-id", id);
    const started = now();
    inFlightNow += 1;
    try {
      await next();
    } finally {
      inFlightNow -= 1;
      const milliseconds = now() - started;
      const status = context.res.status;
      const route = routeLabel(context);
      const method = context.req.method;
      if (options.metrics !== false) {
        requests.inc({ method, route, status: String(status) });
        durations.observe({ method, route }, milliseconds / 1000);
      }
      const failed = status >= 500;
      const slow = milliseconds >= SLOW_REQUEST_MS;
      const quiet = route === "/health" && !failed;
      if (
        options.mode !== "off" &&
        !quiet &&
        (options.mode === "all" || failed || slow)
      ) {
        log(
          JSON.stringify({
            type: "request",
            id,
            method,
            route,
            status,
            ms: Math.round(milliseconds),
            ...(slow ? { slow: true } : {}),
            ...(context.error ? { cause: context.error.name } : {}),
          }),
        );
      }
    }
  };
}

/**
 * What a person is told when something throws that nobody expected: that it happened, and the request
 * id to quote. The detail goes to the log, by name and place and not by message.
 */
export function unhandledError(
  log: (line: string) => void = (line) => console.error(line),
) {
  return (
    error: Error,
    context: Context<{ Variables: AppVariables }>,
  ): Response => {
    // A deliberate refusal thrown as an exception keeps its own answer.
    if (error instanceof HTTPException) return error.getResponse();
    const id = context.get("requestId");
    log(
      JSON.stringify({
        type: "request-failed",
        id,
        method: context.req.method,
        route: routeLabel(context),
        ...describeError(error),
      }),
    );
    return context.json(
      { error: "Something went wrong on our side.", requestId: id },
      500,
    );
  };
}

/**
 * Counts that say how the business is doing, read when the metrics are scraped.
 *
 * Cached for a few seconds so a scraper asking often costs the database nothing extra, and each is
 * one grouped count over an indexed or small table. Every label is a small fixed set (a status, not
 * an id).
 */
export function registerBusinessMetrics(
  registry: Registry,
  database: Database,
  options: { cacheMs?: number; now?: () => number } = {},
) {
  const accounts = registry.gauge(
    "ark_accounts",
    "Accounts, by the status of their subscription.",
    ["status"],
  );
  const runs = registry.gauge(
    "ark_runs_in_progress",
    "Runs holding a slot now (a digital employee working).",
  );
  const charges = registry.gauge(
    "ark_cloud_charges",
    "Months of cloud running, by where they stand. failed and uncertain are waiting for a person.",
    ["status"],
  );
  const cacheMs = options.cacheMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | undefined;

  const read = async () => {
    const bySubscription = await database
      .select({ status: subscriptions.status, n: count() })
      .from(subscriptions)
      .groupBy(subscriptions.status);
    const [slots] = await database
      .select({ n: count() })
      .from(runSlots)
      .where(gt(runSlots.expiresAt, sql`now()`));
    const byCharge = await database
      .select({ status: cloudCharges.status, n: count() })
      .from(cloudCharges)
      .groupBy(cloudCharges.status);
    accounts.clear();
    for (const row of bySubscription) {
      accounts.set({ status: row.status }, Number(row.n));
    }
    runs.set(Number(slots?.n ?? 0));
    charges.clear();
    for (const row of byCharge) {
      charges.set({ status: row.status }, Number(row.n));
    }
  };

  registry.collect(async () => {
    if (now() - readAt < cacheMs) return;
    // One read at a time: scrapes that overlap wait for the same one.
    reading ??= read()
      .then(() => {
        readAt = now();
      })
      .finally(() => {
        reading = undefined;
      });
    await reading;
  });
}

export { serveMetrics } from "../../shared/metrics";
