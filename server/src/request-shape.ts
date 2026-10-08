import type { MiddlewareHandler } from "hono";

/**
 * Refuses a request whose address could not mean anything to this server.
 *
 * A NUL byte (`%00`) in a path or query is not text. Postgres will not store one and answers any
 * query that carries one with an error, so every route that put a path parameter into a query turned
 * that into a server error, thirty-odd of them found by sending `%00` as an id. Nothing legitimate
 * contains one. Refused here, once, before any route sees it, rather than guarded in each.
 *
 * The same goes for an address that is absurdly long: no route has a use for more than a few hundred
 * characters, and the cost of reading one is paid on every request before it is refused.
 */
export const MAX_ADDRESS_LENGTH = 8192;

export function requestShape(): MiddlewareHandler {
  return async (context, next) => {
    const address = context.req.url;
    if (
      address.length > MAX_ADDRESS_LENGTH ||
      address.toLowerCase().includes("%00") ||
      address.includes("\u0000")
    ) {
      return context.json({ error: "That is not a valid address." }, 400);
    }
    return next();
  };
}
