/**
 * The BlackArk Control Board (#149): one `fetch(Request)` for the whole board, so the tests drive it
 * exactly as a browser would, with a fake clock and stand-in sources.
 *
 * Every request is checked in this order:
 *  1. static files and `/healthz` (nothing about anyone);
 *  2. sign-in and setup links, protected by a pre-session CSRF cookie;
 *  3. everything else needs a live session; a POST also needs that session's CSRF token, and is
 *     refused when the browser says it came from another site;
 *  4. the role must allow the page or the action (roles.ts).
 * Every sign-in, refused or not, every sign-out, every page of data opened and every change goes
 * into the audit log.
 */
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { AccessCheck } from "./access";
import {
  type Account,
  activeOwners,
  argon2id,
  completeSetup,
  createPendingAccount,
  disableAccount,
  endSession,
  findAccount,
  findSession,
  findSetupLink,
  listAccounts,
  MAX_SESSION_MS,
  newToken,
  type PasswordHasher,
  pruneSessions,
  resetAccount,
  type Session,
  signIn,
  validRole,
} from "./accounts";
import { appendAudit, countAudit, readAudit, verifyAudit } from "./audit";
import { type Lang, t } from "./i18n";
import * as pages from "./pages";
import { can, canManage, type Permission } from "./roles";
import {
  type CheckinExport,
  type Health,
  remembered,
  type Sources,
  type WorkItem,
} from "./sources";
import { ROLES } from "./store";
import { customerRows, overview, timeline } from "./summary";
import { otpauthUri } from "./totp";

export type BoardOptions = {
  db: Database;
  sources: Sources;
  now?: () => number;
  hasher?: PasswordHasher;
  /** e.g. "https://board.blackark.uk". A POST whose Origin header is another site is refused. */
  publicOrigin?: string;
  /** How long a source's answer is kept before it is asked again. */
  cacheMs?: number;
  log?: (line: string) => void;
  /** Extra routes (milestone 2) tried after the board's own, with the session already checked. */
  extensions?: Extension[];
  /**
   * Cloudflare Access's signed header, checked on every request but `/healthz` (Docker's own check)
   * and `/intake/app` (signed with its own secret, and let through Access by a bypass rule).
   * Absent: not checked.
   */
  access?: AccessCheck;
};

/** Paths that are not behind Cloudflare Access. */
const ACCESS_EXEMPT = new Set(["/healthz", "/intake/app"]);

export type Context = {
  request: Request;
  url: URL;
  lang: Lang;
  session: Session;
  frame: pages.Frame;
  now: number;
  form: URLSearchParams | null;
  audit: (
    action: string,
    target: string | null,
    outcome?: "ok" | "refused",
    detail?: string,
  ) => void;
  refuse: () => Response;
  checkins: () => Promise<{
    value: CheckinExport | null;
    fetchedAt: number | null;
    error?: string;
  }>;
};

export type Extension = {
  /** A response, or null when the path is not this extension's. */
  handle(context: Context): Promise<Response | null>;
  /** Extra timeline events for a customer (cases). */
  timeline?(customerId: string): import("./summary").TimelineEvent[];
  /** A route needing no session (a signed machine endpoint), tried before the session check. */
  handlePublic?(request: Request, url: URL): Promise<Response | null>;
};

const SESSION_COOKIE = "__Host-ark_board";
const PRE_COOKIE = "__Host-ark_board_pre";
const LANG_COOKIE = "ark_board_lang";
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX_FAILURES = 20;
export const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;

const CSS = await Bun.file(new URL("./board.css", import.meta.url)).text();

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000",
  "x-robots-tag": "noindex, nofollow",
};

export function respond(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
  cookies: string[] = [],
): Response {
  const out = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  for (const cookie of cookies) out.append("set-cookie", cookie);
  return new Response(body, { status, headers: out });
}

export function redirect(location: string, cookies: string[] = []): Response {
  return respond("", 303, { location }, cookies);
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

function readCookies(request: Request): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0)
      jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return jar;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return (
    left.length > 0 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function safeBack(path: string | null): string {
  return path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : "/";
}

export function createBoard(options: BoardOptions) {
  const db = options.db;
  const now = options.now ?? Date.now;
  const hasher = options.hasher ?? argon2id;
  const cacheMs = options.cacheMs ?? 60_000;
  const log = options.log ?? ((line: string) => console.log(line));
  const extensions = options.extensions ?? [];
  const ipFailures = new Map<string, number[]>();

  let checkinMs: number | undefined;
  const checkins = remembered(
    async () => {
      const started = now();
      const value = await options.sources.checkins.load();
      checkinMs = now() - started;
      return value;
    },
    cacheMs,
    now,
  );
  const relay = remembered(() => options.sources.relay.check(), cacheMs, now);
  const issues = remembered(() => options.sources.issues.list(), cacheMs, now);
  const billing = remembered(
    () => options.sources.billing.health(),
    cacheMs,
    now,
  );
  const stripe = remembered(
    () => options.sources.billing.snapshot(),
    cacheMs,
    now,
  );

  async function services(): Promise<pages.ServiceRow[]> {
    const [checkin, relayHealth, github, stripe] = await Promise.all([
      checkins(),
      relay(),
      issues(),
      billing(),
    ]);
    const checkinHealth: Health = checkin.error
      ? { up: false, detail: checkin.error }
      : { up: true, detail: "ok", ms: checkinMs };
    const githubHealth: Health = github.error
      ? { up: false, detail: github.error }
      : github.value === null
        ? { up: null, detail: "not connected" }
        : { up: true, detail: "ok" };
    return [
      { name: "Check-in service (blackark.uk)", health: checkinHealth },
      {
        name: "Phone relay",
        health: relayHealth.value ?? {
          up: false,
          detail: relayHealth.error ?? "unreachable",
        },
      },
      { name: "GitHub", health: githubHealth },
      {
        name: "Stripe",
        health: stripe.value ?? {
          up: false,
          detail: stripe.error ?? "unreachable",
        },
      },
    ];
  }

  function audit(
    actor: Account | null,
    action: string,
    target: string | null,
    outcome: "ok" | "refused" = "ok",
    detail?: string,
  ) {
    appendAudit(
      db,
      {
        actor: actor?.username ?? null,
        role: actor?.role ?? null,
        action,
        target,
        outcome,
        detail,
      },
      now(),
    );
  }

  function ipBlocked(ip: string): boolean {
    const recent = (ipFailures.get(ip) ?? []).filter(
      (at) => now() - at < IP_WINDOW_MS,
    );
    ipFailures.set(ip, recent);
    return recent.length >= IP_MAX_FAILURES;
  }

  function ipFailed(ip: string) {
    ipFailures.set(ip, [...(ipFailures.get(ip) ?? []), now()]);
  }

  function crossSite(request: Request): boolean {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return true;
    const origin = request.headers.get("origin");
    return !!(
      origin &&
      options.publicOrigin &&
      origin !== options.publicOrigin
    );
  }

  async function readForm(request: Request): Promise<URLSearchParams | null> {
    if (request.method !== "POST") return null;
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > 32_768) return new URLSearchParams();
    const text = await request.text();
    return new URLSearchParams(text.slice(0, 32_768));
  }

  function preCsrf(jar: Map<string, string>): {
    value: string;
    cookies: string[];
  } {
    const existing = jar.get(PRE_COOKIE);
    if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing))
      return { value: existing, cookies: [] };
    const value = newToken();
    return { value, cookies: [cookie(PRE_COOKIE, value, 3600)] };
  }

  async function handlePublic(
    request: Request,
    url: URL,
    lang: Lang,
    jar: Map<string, string>,
    ip: string,
  ): Promise<Response | null> {
    const frame: pages.Frame = {
      lang,
      path: url.pathname,
      account: null,
      csrf: null,
    };

    if (url.pathname === "/login") {
      const pre = preCsrf(jar);
      if (request.method === "GET") {
        if (findSession(db, jar.get(SESSION_COOKIE) ?? "", now()))
          return redirect("/");
        const ended = url.searchParams.get("ended") === "1";
        return respond(
          pages.loginPage(
            frame,
            pre.value,
            ended
              ? t(lang, "Your session ended. Please sign in again.")
              : undefined,
          ),
          200,
          {},
          pre.cookies,
        );
      }
      if (request.method !== "POST")
        return respond("", 405, { allow: "GET, POST" });
      const form = (await readForm(request)) ?? new URLSearchParams();
      const username = (form.get("username") ?? "").slice(0, 64);
      if (
        crossSite(request) ||
        !same(form.get("csrf") ?? "", jar.get(PRE_COOKIE) ?? "")
      ) {
        audit(null, "sign-in", username || null, "refused", "csrf");
        return respond(
          pages.loginPage(
            frame,
            pre.value,
            t(lang, "The form expired. Please try again."),
          ),
          403,
          {},
          pre.cookies,
        );
      }
      if (ipBlocked(ip)) {
        audit(
          null,
          "sign-in",
          username || null,
          "refused",
          "too many attempts from one address",
        );
        return respond(
          pages.loginPage(
            frame,
            pre.value,
            t(lang, "Too many attempts. Try again in 15 minutes."),
          ),
          429,
          {},
          pre.cookies,
        );
      }
      const result = await signIn(
        db,
        username,
        form.get("password") ?? "",
        form.get("code") ?? "",
        now(),
        hasher,
      );
      if (!result.ok) {
        ipFailed(ip);
        const account = findAccount(db, username.trim().toLowerCase());
        appendAudit(
          db,
          {
            actor: account?.username ?? null,
            role: account?.role ?? null,
            action: "sign-in",
            target: username || null,
            outcome: "refused",
            detail: result.reason,
          },
          now(),
        );
        const message =
          result.reason === "locked"
            ? t(lang, "Too many attempts. Try again in 15 minutes.")
            : t(lang, "Wrong user name, password or code.");
        return respond(
          pages.loginPage(frame, pre.value, message),
          result.reason === "locked" ? 429 : 401,
          {},
          pre.cookies,
        );
      }
      audit(result.account, "sign-in", result.account.username);
      return redirect("/", [
        cookie(SESSION_COOKIE, result.token, MAX_SESSION_MS / 1000),
        cookie(PRE_COOKIE, "", 0),
      ]);
    }

    const setup = url.pathname.match(/^\/setup\/([A-Za-z0-9_-]{43})$/);
    if (setup) {
      const token = setup[1] as string;
      const pre = preCsrf(jar);
      const link = findSetupLink(db, token, now());
      if (!link) {
        return respond(
          pages.messagePage(
            frame,
            t(lang, "Set up your account"),
            t(
              lang,
              "This setup link is not valid. Ask an admin for a new one.",
            ),
          ),
          404,
        );
      }
      const show = (error?: string, status = 200) =>
        respond(
          pages.setupPage(
            frame,
            pre.value,
            link.account.username,
            link.totpSecret,
            otpauthUri(
              "BlackArk Board",
              link.account.username,
              link.totpSecret,
            ),
            error,
          ),
          status,
          {},
          pre.cookies,
        );
      if (request.method === "GET") return show();
      if (request.method !== "POST")
        return respond("", 405, { allow: "GET, POST" });
      const form = (await readForm(request)) ?? new URLSearchParams();
      if (
        crossSite(request) ||
        !same(form.get("csrf") ?? "", jar.get(PRE_COOKIE) ?? "")
      ) {
        audit(
          link.account,
          "account.setup",
          link.account.username,
          "refused",
          "csrf",
        );
        return show(t(lang, "The form expired. Please try again."), 403);
      }
      if (ipBlocked(ip))
        return show(
          t(lang, "Too many attempts. Try again in 15 minutes."),
          429,
        );
      const result = await completeSetup(
        db,
        token,
        form.get("password") ?? "",
        form.get("repeat") ?? "",
        form.get("code") ?? "",
        now(),
        hasher,
      );
      if (!result.ok) {
        if (result.reason === "code") ipFailed(ip);
        audit(
          link.account,
          "account.setup",
          link.account.username,
          "refused",
          result.reason,
        );
        const messages: Record<string, string> = {
          "password-short": "The password needs at least 12 characters.",
          "password-mismatch": "The two passwords are not the same.",
          code: "That code is not right. Check your app's time and try the next code.",
          link: "This setup link is not valid. Ask an admin for a new one.",
        };
        return show(t(lang, messages[result.reason] ?? ""), 400);
      }
      audit(result.account, "account.setup", result.account.username);
      return respond(
        pages.messagePage(
          frame,
          t(lang, "Set up your account"),
          t(lang, "Setup is done. You can sign in now."),
        ),
        200,
        {},
        [cookie(PRE_COOKIE, "", 0)],
      );
    }
    return null;
  }

  async function handleSignedIn(context: Context): Promise<Response> {
    const { url, session, frame, lang } = context;
    const role = session.account.role;
    const method = context.request.method;
    const path = url.pathname;

    if (path === "/logout" && method === "POST") {
      endSession(db, session.tokenHash);
      context.audit("sign-out", session.account.username);
      return redirect("/login", [cookie(SESSION_COOKIE, "", 0)]);
    }

    const needs = (permission: Permission) => can(role, permission);

    if (method === "GET" && path === "/") {
      const data = await checkins();
      context.audit("view", "overview");
      return respond(
        pages.overviewPage(
          frame,
          data.value ? overview(data.value, context.now) : null,
          await services(),
          pages.staleBanner(lang, data.fetchedAt, data.error),
          (await stripe()).value?.failed.length ?? null,
        ),
      );
    }

    if (method === "GET" && path === "/customers") {
      const data = await checkins();
      const filter = url.searchParams.get("plan");
      const known = (pages.CUSTOMER_FILTERS as readonly string[]).includes(
        filter ?? "",
      )
        ? filter
        : null;
      context.audit("view", "customers", "ok", known ?? undefined);
      const rows = data.value ? customerRows(data.value, context.now) : [];
      return respond(
        pages.customersPage(
          frame,
          pages.filterCustomers(rows, known),
          known,
          pages.staleBanner(lang, data.fetchedAt, data.error),
        ),
      );
    }

    const customer = path.match(/^\/customers\/([^/]+)$/);
    if (method === "GET" && customer) {
      let id = "";
      try {
        id = decodeURIComponent(customer[1] as string);
      } catch {}
      if (!CUSTOMER_ID.test(id)) return notFound(frame);
      const data = await checkins();
      context.audit("view", `customer:${id}`);
      const rows = data.value ? customerRows(data.value, context.now) : [];
      const extra = extensions.flatMap(
        (extension) => extension.timeline?.(id) ?? [],
      );
      const events = data.value ? timeline(data.value, id, extra) : extra;
      return respond(
        pages.customerPage(
          frame,
          id,
          rows.find((row) => row.customerId === id) ?? null,
          events,
          pages.staleBanner(lang, data.fetchedAt, data.error),
          extensions.length > 0 && needs("cases.write"),
        ),
      );
    }

    if (method === "GET" && path === "/billing") {
      context.audit("view", "billing");
      const result = await stripe();
      return respond(pages.billingPage(frame, result.value, result.error));
    }

    if (method === "GET" && path === "/services") {
      context.audit("view", "services");
      return respond(pages.servicesPage(frame, await services()));
    }

    if (method === "GET" && path === "/issues") {
      context.audit("view", "issues");
      const result = await issues();
      const items: WorkItem[] | null = result.value;
      return respond(pages.issuesPage(frame, items, result.error));
    }

    if (method === "GET" && path === "/audit") {
      if (!needs("audit.read")) return context.refuse();
      const perPage = 100;
      const total = countAudit(db);
      const pagesCount = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(
        pagesCount,
        Math.max(
          1,
          Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
        ),
      );
      context.audit(
        "view",
        "audit",
        "ok",
        page > 1 ? `page ${page}` : undefined,
      );
      return respond(
        pages.auditPage(
          frame,
          readAudit(db, perPage, (page - 1) * perPage),
          page,
          pagesCount,
          verifyAudit(db),
        ),
      );
    }

    if (path === "/accounts") {
      if (!needs("accounts.manage")) return context.refuse();
      const manageable = ROLES.filter((target) => canManage(role, target));
      const show = (
        message?: { setupLink?: string; username?: string; error?: string },
        status = 200,
      ) =>
        respond(
          pages.accountsPage(
            frame,
            listAccounts(db),
            [...manageable],
            (account) =>
              canManage(role, account.role) &&
              account.id !== session.account.id,
            message,
          ),
          status,
        );
      if (method === "GET") {
        context.audit("view", "accounts");
        return show();
      }
      if (method !== "POST") return respond("", 405, { allow: "GET, POST" });
      const form = context.form ?? new URLSearchParams();
      const action = form.get("action") ?? "";
      const username = (form.get("username") ?? "").trim().toLowerCase();
      const link = (token: string) =>
        `${options.publicOrigin ?? url.origin}/setup/${token}`;
      if (action === "create") {
        const wanted = form.get("role") ?? "";
        if (!validRole(wanted) || !canManage(role, wanted)) {
          context.audit(
            "account.create",
            username,
            "refused",
            `role ${wanted}`,
          );
          return context.refuse();
        }
        try {
          const token = createPendingAccount(
            db,
            username,
            wanted,
            session.account.username,
            context.now,
          );
          context.audit("account.create", username, "ok", `role ${wanted}`);
          return show({ setupLink: link(token), username });
        } catch (error) {
          const taken = error instanceof Error && error.message === "taken";
          context.audit(
            "account.create",
            username,
            "refused",
            taken ? "taken" : "bad user name",
          );
          return show(
            {
              error: t(
                lang,
                taken
                  ? "That user name is taken."
                  : "That user name is not valid.",
              ),
            },
            400,
          );
        }
      }
      if (action === "reset" || action === "disable") {
        const target = findAccount(db, username);
        if (!target) return show({ error: t(lang, "No such account.") }, 404);
        if (!canManage(role, target.role) || target.id === session.account.id) {
          context.audit(
            `account.${action}`,
            username,
            "refused",
            `role ${target.role}`,
          );
          return context.refuse();
        }
        if (
          target.role === "owner" &&
          target.status === "active" &&
          activeOwners(db) <= 1
        ) {
          context.audit(`account.${action}`, username, "refused", "last owner");
          return show(
            {
              error: t(
                lang,
                "The last active owner cannot be disabled or reset.",
              ),
            },
            400,
          );
        }
        if (action === "disable") {
          disableAccount(db, target);
          context.audit("account.disable", username);
          return show();
        }
        const token = resetAccount(db, target, context.now);
        context.audit("account.reset", username);
        return show({ setupLink: link(token), username });
      }
      return respond("", 400);
    }

    for (const extension of extensions) {
      const answer = await extension.handle(context);
      if (answer) return answer;
    }
    return notFound(frame);
  }

  function notFound(frame: pages.Frame): Response {
    return respond(
      pages.messagePage(
        frame,
        t(frame.lang, "Not found"),
        t(frame.lang, "There is no such page."),
      ),
      404,
    );
  }

  return {
    /** `ip` is the caller's address (from Caddy), kept in memory for 15 minutes for sign-in limits only. */
    async fetch(request: Request, ip = "unknown"): Promise<Response> {
      const url = new URL(request.url);
      const jar = readCookies(request);
      const lang: Lang = jar.get(LANG_COOKIE) === "el" ? "el" : "en";

      if (options.access && !ACCESS_EXEMPT.has(url.pathname)) {
        const passed = await options.access(request);
        if (!passed.ok) {
          log(
            `control-board: refused without Cloudflare Access (${passed.reason})`,
          );
          return new Response("Not through Cloudflare Access.", {
            status: 403,
            headers: {
              "content-type": "text/plain",
              "cache-control": "no-store",
              ...SECURITY_HEADERS,
            },
          });
        }
      }

      if (url.pathname === "/board.css") {
        return new Response(CSS, {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "max-age=3600",
            ...SECURITY_HEADERS,
          },
        });
      }
      if (url.pathname === "/healthz") {
        return new Response("ok", {
          headers: {
            "content-type": "text/plain",
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname === "/lang" && request.method === "GET") {
        const to = url.searchParams.get("to") === "el" ? "el" : "en";
        return redirect(safeBack(url.searchParams.get("back")), [
          `${LANG_COOKIE}=${to}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`,
        ]);
      }

      const open = await handlePublic(request, url, lang, jar, ip);
      if (open) return open;
      for (const extension of extensions) {
        const answer = await extension.handlePublic?.(request, url);
        if (answer) return answer;
      }

      pruneSessions(db, now());
      const session = findSession(db, jar.get(SESSION_COOKIE) ?? "", now());
      if (!session) {
        const hadOne = jar.has(SESSION_COOKIE);
        return redirect(
          hadOne ? "/login?ended=1" : "/login",
          hadOne ? [cookie(SESSION_COOKIE, "", 0)] : [],
        );
      }
      const frame: pages.Frame = {
        lang,
        path: url.pathname,
        account: session.account,
        csrf: session.csrf,
        cases: extensions.length > 0,
      };
      const form = await readForm(request);
      const context: Context = {
        request,
        url,
        lang,
        session,
        frame,
        now: now(),
        form,
        audit: (action, target, outcome = "ok", detail) =>
          audit(session.account, action, target, outcome, detail),
        refuse: () => {
          audit(
            session.account,
            "refused",
            `${request.method} ${url.pathname}`,
            "refused",
            "role",
          );
          return respond(
            pages.messagePage(
              frame,
              t(lang, "Not allowed"),
              t(lang, "Your role does not allow this."),
            ),
            403,
          );
        },
        checkins,
      };
      if (request.method === "POST") {
        if (
          crossSite(request) ||
          !same(form?.get("csrf") ?? "", session.csrf)
        ) {
          audit(
            session.account,
            "refused",
            `POST ${url.pathname}`,
            "refused",
            "csrf",
          );
          return respond(
            pages.messagePage(
              frame,
              t(lang, "Not allowed"),
              t(lang, "The form expired. Please try again."),
            ),
            403,
          );
        }
      } else if (request.method !== "GET" && request.method !== "HEAD") {
        return respond("", 405);
      }
      try {
        return await handleSignedIn(context);
      } catch (error) {
        log(
          `control-board: ${request.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return respond(
          pages.messagePage(
            frame,
            t(lang, "Error"),
            t(lang, "Something went wrong. It is in the server log."),
          ),
          500,
        );
      }
    },
  };
}
