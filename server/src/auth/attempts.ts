/**
 * How many wrong passwords in a row (security review of v0.1.54, 25 Nov 2026).
 *
 * Password sign-in had no limit on desktop installs: Better Auth limits attempts only in production,
 * and a desktop server never runs as production. With the office network on, anybody on that
 * network could guess the administrator's password without end. Now five wrong passwords for one
 * account within fifteen minutes lock it for fifteen minutes, and every wrong one is written down.
 *
 * Kept in memory: a desktop ArkAgent is one server process, and password sign-in is only offered
 * there. A restart forgets it, which at worst gives a guesser five more tries after a restart they
 * cannot cause.
 */
import type { Context, MiddlewareHandler } from "hono";

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;

export type AttemptLimiter = ReturnType<typeof createAttemptLimiter>;

/** How many accounts' counts are kept at most. */
const MAX_KEYS = 10_000;

export function createAttemptLimiter(
  options: {
    maxFailures?: number;
    windowMs?: number;
    lockMs?: number;
    now?: () => number;
  } = {},
) {
  const maxFailures = options.maxFailures ?? MAX_FAILURES;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const lockMs = options.lockMs ?? LOCK_MS;
  const now = options.now ?? Date.now;
  const failures = new Map<string, number[]>();
  const lockedUntil = new Map<string, number>();
  const inFlight = new Set<string>();

  /**
   * Old entries go, so a flood of made-up keys cannot fill the memory. If a flood within the window
   * still leaves too many, the oldest counts go first (never a lock): at worst one account's count
   * of wrong passwords starts again, and a password check is slow enough that this takes a lot.
   */
  function prune(at: number) {
    if (failures.size + lockedUntil.size < MAX_KEYS) return;
    for (const [key, times] of failures)
      if (times.every((when) => at - when >= windowMs)) failures.delete(key);
    for (const [key, until] of lockedUntil)
      if (until <= at) lockedUntil.delete(key);
    for (const key of failures.keys()) {
      if (failures.size + lockedUntil.size < MAX_KEYS / 2) break;
      failures.delete(key);
    }
  }

  return {
    /**
     * One attempt at a time per key (security review of v0.1.55): an attempt starts only when no
     * other for the same account is still being checked, so a burst sent at once is answered one
     * by one, each counted before the next. False when one is already running.
     */
    begin(key: string): boolean {
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },

    end(key: string) {
      inFlight.delete(key);
    },

    /** How long this key stays locked, in milliseconds; 0 when it is not. */
    lockedFor(key: string): number {
      const until = lockedUntil.get(key) ?? 0;
      const left = until - now();
      if (left > 0) return left;
      lockedUntil.delete(key);
      return 0;
    },

    /** A wrong one. True when this one locked the key. */
    fail(key: string): boolean {
      const at = now();
      prune(at);
      const recent = (failures.get(key) ?? []).filter(
        (when) => at - when < windowMs,
      );
      recent.push(at);
      if (recent.length >= maxFailures) {
        failures.delete(key);
        lockedUntil.set(key, at + lockMs);
        return true;
      }
      failures.set(key, recent);
      return false;
    },

    /** A right one: the count starts again. */
    succeed(key: string) {
      failures.delete(key);
    },
  };
}

/**
 * The route guard: refused while the key is locked, or while another attempt for it is still being
 * checked; after the route answers, a wrong password (400, 401 or 403) counts, and a right one starts
 * the count again. An attempt that throws counts as wrong. A key of null is not counted at all (a
 * password change from somebody with no session, which the route refuses anyway).
 */
export function attemptGuard(options: {
  limiter: AttemptLimiter;
  keyOf: (context: Context) => Promise<string | null>;
  onFailure?: (context: Context, locked: boolean) => Promise<void>;
}): MiddlewareHandler {
  const tooMany = (context: Context, minutes: number) =>
    context.json(
      {
        error: `Too many wrong passwords. Try again in ${minutes} minutes.`,
        code: "too_many_attempts",
      },
      429,
    );
  return async (context, next) => {
    if (context.req.method !== "POST") return next();
    const key = await options.keyOf(context);
    if (key === null) return next();
    const left = options.limiter.lockedFor(key);
    if (left > 0) return tooMany(context, Math.ceil(left / 60_000));
    if (!options.limiter.begin(key))
      return context.json(
        {
          error:
            "Another sign-in for this account is still being checked. Wait a moment, then try again.",
          code: "attempt_in_progress",
        },
        429,
      );
    let status = 0;
    try {
      await next();
      // Hono turns a throw into a 500 and keeps the error: still a throw, so still counted.
      status = context.error ? 0 : context.res.status;
    } finally {
      options.limiter.end(key);
      // A throw counts as wrong (it may be a way round the check). A server error answered as one
      // (the database is down) is not a wrong password, and is not written down as one.
      if (status === 0 || status === 400 || status === 401 || status === 403) {
        const locked = options.limiter.fail(key);
        await options.onFailure?.(context, locked).catch(() => undefined);
      } else if (status < 300) options.limiter.succeed(key);
    }
  };
}

/**
 * Sign-in takes JSON only, with an email (security review of v0.1.56). Better Auth also reads a web
 * form, and the limiter cannot see a form's email, so a form attempt would share one count with
 * every other form attempt, which any right password then cleared. The app always sends JSON.
 */
export function jsonSignInOnly(): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.method !== "POST") return next();
    const type = (context.req.header("content-type") ?? "").toLowerCase();
    if (!(type.split(";")[0] ?? "").trim().endsWith("/json"))
      return context.json(
        { error: "Sign in from the ArkAgent app.", code: "json_only" },
        415,
      );
    const body = (await context.req.raw
      .clone()
      .json()
      .catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email !== "string" || body.email.trim() === "")
      return context.json(
        { error: "Write your email and password.", code: "email_required" },
        400,
      );
    return next();
  };
}
