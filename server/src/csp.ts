import { Hono } from "hono";
import { createLimiter } from "./rate-limit";

/**
 * The Content-Security-Policy: what a page may load and talk to, so that an injected script has
 * little to work with if one ever gets in.
 *
 * It is a second line. Nothing here replaces output escaping, and the app has no
 * `dangerouslySetInnerHTML`. It limits the damage of the bug that was not found.
 *
 * THE MODE. `report-only` (the default) sends the policy as `Content-Security-Policy-Report-Only`: the
 * browser tells `/api/csp-report` what it would have blocked and blocks nothing. `enforce` blocks. `off`
 * sends only `frame-ancestors`, which has always been enforced. A policy that was not run against every
 * screen breaks one silently, which is why the default is to watch first. docs/ark/15-security-review.md
 * (O3) says how to move from one to the next.
 */

export type CspMode = "off" | "report-only" | "enforce";

export function parseCspMode(value: string | undefined): CspMode {
  const mode = (value ?? "report-only").trim().toLowerCase();
  if (mode === "off" || mode === "report-only" || mode === "enforce") {
    return mode;
  }
  throw new Error("CSP_MODE must be off, report-only or enforce.");
}

/** Where the browser posts what it would have blocked. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * The origin of an address, in the form a `connect-src` wants: a web socket address is written with
 * its own scheme. Anything that is not an address is nothing.
 */
function originOf(address: string | undefined): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return null;
  }
}

/**
 * The policy for the application's own pages.
 *
 * What each directive allows, and why:
 * - `script-src 'self'`: the bundle Vite built, and nothing inline and no `eval`. This is the
 *   directive that does the work.
 * - `style-src 'self' 'unsafe-inline'`: the app sets `style=` on elements as React does, and the
 *   interface library injects style rules. Inline *style* cannot run code; script is where the
 *   protection is.
 * - `img-src 'self' data: blob: https:`: a coworker's answer may show an image from anywhere, and the
 *   live screen of a coworker's browser arrives as a picture.
 * - `connect-src 'self'` and the conversation hub (the page's own socket address is added too, since
 *   not every browser treats `'self'` as covering `ws:`).
 * - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`: the
 *   directives that close doors for free.
 */
export function appPolicy(options: {
  /** The addresses the page itself is reached at, whose socket form is allowed too. */
  selfOrigins?: (string | undefined)[];
  /** The conversation hub, which a browser opens a live connection to. */
  hubAddress?: string;
  reportUri?: string;
}): string {
  const sockets = new Set<string>();
  for (const address of options.selfOrigins ?? []) {
    const origin = originOf(address);
    if (!origin) continue;
    const url = new URL(origin);
    sockets.add(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`);
  }
  const hub = originOf(options.hubAddress);
  if (hub) {
    const url = new URL(hub);
    sockets.add(hub);
    sockets.add(
      `${url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"}//${url.host}`,
    );
  }
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["connect-src", ["'self'", ...sockets]],
    ["worker-src", ["'self'", "blob:"]],
    ["frame-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
  ];
  if (options.reportUri) directives.push(["report-uri", [options.reportUri]]);
  return directives
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/**
 * The policy watched on the payment page. Paddle's checkout is a script from Paddle on a page of ours
 * that opens Paddle's own frame, and that page carries an inline script with the account's token, so
 * the application policy would be wrong for it in any mode.
 *
 * ALWAYS report-only, whatever the mode: the allowances for Paddle come from its documentation, have
 * not been exercised against Paddle itself (docs/ark/12-paddle.md, the sandbox run), and a wrong guess
 * that is enforced is a customer who cannot pay. Tighten it from what the sandbox run reports.
 */
export function checkoutPolicy(options: { reportUri?: string }): string {
  const directives: [string, string[]][] = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'", "'unsafe-inline'", "https://cdn.paddle.com"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "https:"]],
    ["font-src", ["https:", "data:"]],
    ["connect-src", ["'self'", "https://*.paddle.com"]],
    ["frame-src", ["https://*.paddle.com"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
  ];
  if (options.reportUri) directives.push(["report-uri", [options.reportUri]]);
  return directives
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** What a violation report is allowed to put in the log, and no more. */
export type Violation = {
  type: "csp-violation";
  directive: string;
  blocked: string;
  page: string;
  source: string | null;
  disposition: string;
};

const MAX_REPORT_BYTES = 16 * 1024;
const FIELD = 200;

/** An address without its query or fragment, which can carry anything. */
function plain(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  // "inline", "eval", "data", "blob" and the like are not addresses and are the useful part.
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") {
      return url.protocol;
    }
    return `${url.origin}${url.pathname}`.slice(0, FIELD);
  } catch {
    return value.replace(/[^\w:.-]/g, "").slice(0, FIELD);
  }
}

const text = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/[^\w\s'-]/g, "").slice(0, FIELD)
    : "";

/**
 * Reads the two shapes a browser sends: the older `{"csp-report": {...}}` and the Reporting API's
 * list of `{type: "csp-violation", body: {...}}`. Anything else is nothing.
 */
export function readReports(payload: unknown): Violation[] {
  const bodies: Record<string, unknown>[] = [];
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (Array.isArray(payload)) {
    for (const entry of payload.slice(0, 20)) {
      const item = record(entry);
      const body = record(item?.body);
      if (item?.type === "csp-violation" && body) bodies.push(body);
    }
  } else {
    const body = record(record(payload)?.["csp-report"]);
    if (body) bodies.push(body);
  }
  return bodies.map((body) => ({
    type: "csp-violation" as const,
    directive: text(
      body["effective-directive"] ??
        body.effectiveDirective ??
        body["violated-directive"] ??
        body.violatedDirective,
    ),
    blocked: plain(body["blocked-uri"] ?? body.blockedURL ?? body.blockedURI),
    page: plain(body["document-uri"] ?? body.documentURL ?? body.documentURI),
    source: plain(body["source-file"] ?? body.sourceFile) || null,
    disposition: text(body.disposition) || "report",
  }));
}

/**
 * The door the browser posts violations to. Public, because the browser sends it on its own and
 * cannot sign in: so it is small, limited per address, answers the same to everything it accepts, and
 * writes only the few fields in {@link Violation} to the log, never the report as sent. A page that
 * is under attack, or a hostile script, can fill this log; the dedupe and the limit are what keep that
 * from being expensive.
 */
export function cspReportRoutes(options: {
  log?: (violation: Violation) => void;
  /** Reports per address per minute. */
  perMinute?: number;
}) {
  const app = new Hono();
  const allowed = createLimiter(options.perMinute ?? 60, 60_000);
  const seen = new Map<string, number>();
  const log =
    options.log ??
    ((violation: Violation) => console.warn(JSON.stringify(violation)));

  app.post("/", async (context) => {
    const forwarded = context.req.header("x-forwarded-for") ?? "";
    // The last hop is the one the ingress itself saw. Earlier ones are whatever the client wrote.
    const who = forwarded.split(",").at(-1)?.trim() || "unknown";
    if (!allowed(who)) return context.body(null, 429);

    const declared = Number(context.req.header("content-length") ?? "0");
    if (declared > MAX_REPORT_BYTES) return context.body(null, 413);
    const kind = (context.req.header("content-type") ?? "").split(";")[0] ?? "";
    if (
      ![
        "application/csp-report",
        "application/json",
        "application/reports+json",
      ].includes(kind.trim().toLowerCase())
    ) {
      return context.body(null, 415);
    }
    const raw = await context.req.text().catch(() => "");
    if (raw.length > MAX_REPORT_BYTES) return context.body(null, 413);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return context.body(null, 400);
    }
    for (const violation of readReports(payload)) {
      // Once for each distinct thing per hour per process: a page that repeats one violation a
      // thousand times is one line, not a thousand.
      const key = `${violation.directive}|${violation.blocked}|${violation.page}`;
      const now = Date.now();
      const last = seen.get(key);
      if (last !== undefined && now - last < 3_600_000) continue;
      seen.set(key, now);
      if (seen.size > 500) {
        for (const [name, at] of seen) {
          if (now - at >= 3_600_000) seen.delete(name);
        }
        if (seen.size > 500) seen.clear();
      }
      log(violation);
    }
    return context.body(null, 204);
  });
  return app;
}
