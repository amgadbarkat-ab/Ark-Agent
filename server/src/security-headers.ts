import type { MiddlewareHandler } from "hono";

/**
 * The headers every response carries, so a browser does its part of keeping this site safe.
 *
 * None of this replaces a check in the server. It makes a mistake somewhere else cost less: a page
 * that cannot be put in somebody else's frame cannot be clickjacked, a file that is never sniffed
 * into a script cannot run as one, and a connection that has once been secure is not downgraded.
 *
 * WHAT IS NOT HERE, ON PURPOSE. A full Content-Security-Policy. The app is built by Vite, draws bot
 * output and Paddle's checkout, and a policy written without running every screen under it breaks one
 * of them silently. It is listed in docs/ark/15-security-review.md as work to do with the screens in
 * front of us, not guessed at. `frame-ancestors` is a CSP directive on its own, so the one part that
 * matters most is here without the rest.
 *
 * A response that already set a header keeps it: the browser sign-in page sets its own policy, and the
 * most specific author knows best.
 */
export function securityHeaders(options: {
  /** Whether this deployment is reached over HTTPS. HSTS on plain HTTP would be ignored, and on a
   * laptop it would pin `localhost` to HTTPS for a year. */
  https: boolean;
}): MiddlewareHandler {
  const wanted: Array<[string, string]> = [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["content-security-policy", "frame-ancestors 'self'"],
    // Dictation and voice need the microphone. Nothing here needs a camera or a location.
    ["permissions-policy", "microphone=(self), camera=(), geolocation=()"],
  ];
  if (options.https) {
    wanted.push([
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    ]);
  }

  const apply = (response: Response) => {
    for (const [name, value] of wanted) {
      if (!response.headers.has(name)) response.headers.set(name, value);
    }
  };

  return async (context, next) => {
    await next();
    const response = context.res;
    if (!response) return;
    try {
      apply(response);
    } catch {
      // A response that came back from another server has headers that cannot be changed. Copy it.
      const copy = new Response(response.body, response);
      apply(copy);
      context.res = copy;
    }
  };
}
