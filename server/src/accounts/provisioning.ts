import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";

/**
 * Makes sure a signed-in person belongs to an account before anything else runs for them.
 *
 * Whatever a person can see depends on their account (see visibility.ts), so a person without one
 * would be unable to see a colleague's shared coworker until some other action happened to make theirs.
 * Doing it here, on the way in, means every route and every later background run for this person
 * can rely on the account existing.
 *
 * Remembered per process once done, so the cost is one query the first time a person is seen, not
 * one per request.
 */
export function withAccountProvisioning(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ensureTenant: (userId: string) => Promise<string>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  const known = new Set<string>();
  return (context, next) =>
    requireUser(context, async () => {
      const id = context.var.actor.id;
      if (!known.has(id)) {
        await ensureTenant(id);
        // Bounded: a long-running process serving many people should not grow without end.
        if (known.size >= 50_000) known.clear();
        known.add(id);
      }
      await next();
    });
}
