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

  return {
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
 * The route guard: refused while the key is locked; after the route answers, a wrong password
 * (400, 401 or 403) counts, and a right one starts the count again.
 */
export function attemptGuard(options: {
  limiter: AttemptLimiter;
  keyOf: (context: Context) => Promise<string>;
  onFailure?: (context: Context, locked: boolean) => Promise<void>;
}): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.method !== "POST") return next();
    const key = await options.keyOf(context);
    const left = options.limiter.lockedFor(key);
    if (left > 0) {
      const minutes = Math.ceil(left / 60_000);
      return context.json(
        {
          error: `Too many wrong passwords. Try again in ${minutes} minutes.`,
          code: "too_many_attempts",
        },
        429,
      );
    }
    await next();
    const status = context.res.status;
    if (status === 400 || status === 401 || status === 403) {
      const locked = options.limiter.fail(key);
      await options.onFailure?.(context, locked).catch(() => undefined);
    } else if (status < 300) options.limiter.succeed(key);
  };
}
