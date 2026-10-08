/**
 * A fixed window per person (or per anything else with a name): enough for ordinary use, little
 * enough to be no scanner. Kept in memory, so it is per server process, which is the point of a
 * brake and not a ledger.
 */
export function createLimiter(limit: number, windowMs: number) {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (who: string, now = Date.now()) => {
    const entry = seen.get(who);
    if (!entry || entry.resetAt <= now) {
      seen.set(who, { count: 1, resetAt: now + windowMs });
      if (seen.size > 10_000) {
        for (const [name, value] of seen) {
          if (value.resetAt <= now) seen.delete(name);
        }
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
