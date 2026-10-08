import type { MiddlewareHandler } from "hono";

/**
 * The headers every response carries, so a browser does its part of keeping this site safe.
 *
 * None of this replaces a check in the server. It makes a mistake somewhere else cost less: a page
 * that cannot be put in somebody else's frame cannot be clickjacked, a file that is never sniffed
 * into a script cannot run as one, and a connection that has once been secure is not downgraded.
 *
 * THE CONTENT-SECURITY-POLICY. `frame-ancestors 'self'` is always sent and always enforced, as it has
 * been from the start. The full policy (`csp.ts`) is sent as a report-only header by default, so the
 * browser says what it would have blocked before anything is blocked, and as an enforced one only when
 * the deployment has asked for it (`CSP_MODE`). A page that is not the application (the sign-in
 * library's, the payment page) sets its own policy and is left alone.
 *
 * A response that already set a header keeps it: the browser sign-in page sets its own policy, and the
 * most specific author knows best.
 */
export function securityHeaders(options: {
  /** Whether this deployment is reached over HTTPS. HSTS on plain HTTP would be ignored, and on a
   * laptop it would pin `localhost` to HTTPS for a year. */
  https: boolean;
  /** The full policy and how hard to hold to it. Absent is only `frame-ancestors`. */
  csp?: { mode: "off" | "report-only" | "enforce"; policy: string };
}): MiddlewareHandler {
  const mode = options.csp?.mode ?? "off";
  const wanted: Array<[string, string]> = [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
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
    // A page with a policy of its own (either header) is that page's author's to decide.
    if (
      response.headers.has("content-security-policy") ||
      response.headers.has("content-security-policy-report-only")
    ) {
      return;
    }
    if (options.csp && mode === "enforce") {
      response.headers.set("content-security-policy", options.csp.policy);
      return;
    }
    response.headers.set("content-security-policy", "frame-ancestors 'self'");
    if (options.csp && mode === "report-only") {
      response.headers.set(
        "content-security-policy-report-only",
        options.csp.policy,
      );
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
