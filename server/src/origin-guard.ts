import type { MiddlewareHandler } from "hono";

/**
 * A browser request that changes something must come from this site, or from one named as trusted.
 *
 * WHAT THIS IS FOR. The session cookie is `SameSite=Lax`, which is what actually keeps another website
 * from making a signed-in person's browser change their settings. This is the second wall behind it,
 * for the cases the first does not cover: a page on a sibling subdomain of ours (same site, so Lax
 * does not apply), a browser that does not honour SameSite, and a future change to the cookie. What
 * a forged request could do is not small: set somebody's standing instructions, or add a model
 * connection that sends their conversations to an address of the attacker's choosing.
 *
 * HOW IT DECIDES. Browsers say where a request came from, and a page cannot change what they say:
 * `Origin` on anything but a plain navigation, and `Sec-Fetch-Site` on every request. A request that
 * says it came from somewhere else is refused. A request that says nothing at all is not a browser
 * (a script, `curl`, a service calling in) and is let through to be authenticated like any other:
 * the point is to stop a browser being used against its owner, not to stop clients that carry no
 * ambient credentials.
 *
 * NOT APPLIED where something else authenticates the caller and no browser is involved, or where the
 * library in charge already checks the origin itself: the sign-in routes (`/api/auth`), Paddle's
 * notices (signed), the model gateway and bot tool calls (a signed grant or token, from a Bot's own
 * computer), the desktop's polling (a token), and the internal routines endpoint (a shared secret).
 *
 * WebSocket handshakes are GETs, and a GET is normally exempt. A handshake is the one GET that
 * carries a browser's cookies into something that then acts as the person for as long as it is open,
 * and a page on any origin may open one, so it is checked like a write.
 */

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Authenticated by something other than the browser's cookie, or checked by the library that owns it. */
const EXEMPT_PREFIXES = [
  "/api/auth/",
  "/api/billing/webhook/",
  "/api/model-gateway/",
  "/api/agent-tools/",
  "/api/host-access/desktop/",
  "/internal/",
];

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a browser request comes from this site or a trusted one. True for a request that says
 * nothing about where it came from, which is not a browser.
 */
export function originAllowed(
  headers: Headers,
  trusted: ReadonlySet<string>,
): boolean {
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site");

  // Nothing says a browser sent this, so there is no cookie being borrowed.
  if (origin === null && site === null) return true;

  if (origin !== null) {
    if (trusted.has(normalise(origin))) return true;
    // Compared with where this request was sent, ignoring the scheme: behind a proxy that ends TLS
    // the server sees `http` for a site people reach over `https`, and the host is the part an
    // attacker cannot make match.
    const own = headers.get("x-forwarded-host") ?? headers.get("host");
    const claimed = origin === "null" ? null : hostOf(origin);
    return claimed !== null && own !== null && claimed === own.toLowerCase();
  }

  // No Origin (some same-origin requests omit it) but the browser says where it came from.
  return site === "same-origin" || site === "none";
}

const normalise = (origin: string) => origin.replace(/\/+$/, "").toLowerCase();

export function trustedOrigins(
  origins: readonly (string | undefined)[],
): Set<string> {
  return new Set(
    origins
      .filter((origin): origin is string => Boolean(origin))
      .map(normalise),
  );
}

export function originGuard(options: {
  /** Origins that may act as the signed-in person even though they are not this site, such as a separately hosted app. */
  trusted: readonly (string | undefined)[];
}): MiddlewareHandler {
  const trusted = trustedOrigins(options.trusted);

  return async (context, next) => {
    const request = context.req.raw;
    const handshake =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (
      (!UNSAFE.has(request.method) && !handshake) ||
      EXEMPT_PREFIXES.some((prefix) => context.req.path.startsWith(prefix))
    ) {
      return next();
    }
    if (originAllowed(request.headers, trusted)) return next();
    return context.json(
      { error: "This request came from another website." },
      403,
    );
  };
}
