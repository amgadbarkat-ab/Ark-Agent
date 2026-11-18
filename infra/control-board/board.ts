/**
 * The BlackArk Control Board (#149): one `fetch(Request)` for the whole board. On Cloudflare it is
 * the Worker's fetch handler (worker.ts); in the tests and `dev.ts` it runs on Bun with a local
 * SQLite stand-in for D1, so the tests drive it exactly as a browser would.
 *
 * Every request is checked in this order:
 *  1. Cloudflare Access's signed header, when configured (always with FIRST_FACTOR=access);
 *  2. static files and `/healthz` (nothing about anyone);
 *  3. sign-in and setup links, protected by a pre-session CSRF cookie: the first factor (Access's
 *     email, or a passkey) and then the board's TOTP;
 *  4. everything else needs a live session; a POST also needs that session's CSRF token, and is
 *     refused when the browser says it came from another site;
 *  5. the role must allow the page or the action (roles.ts).
 * Every sign-in, refused or not, every sign-out, every page of data opened and every change goes
 * into the audit log.
 *
 * Nothing here fetches a source: the Cron Trigger does (cron.ts) and pages read its snapshots, so a
 * page stays within the Worker's 10 ms of CPU.
 */
import { timingSafeEqual } from "node:crypto";
import type { AccessCheck } from "./access";
import {
  type Account,
  activeOwners,
  clearFailures,
  completeSetup,
  createPendingAccount,
  disableAccount,
  endSession,
  failures,
  findAccount,
  findAccountByEmail,
  findAccountById,
  findPasskey,
  findSession,
  findSetupLink,
  finishSignIn,
  listAccounts,
  MAX_ADDRESS_FAILURES,
  MAX_FAILURES,
  MAX_SESSION_MS,
  newChallenge,
  newToken,
  recordFailure,
  resetAccount,
  type Session,
  setSignCount,
  sha256,
  takeChallenge,
  validRole,
} from "./accounts";
import { appendAudit, countAudit, readAudit } from "./audit";
import { CSS } from "./board-css";
import { type Lang, t } from "./i18n";
import * as pages from "./pages";
import { can, canManage, type Permission } from "./roles";
import { readSnapshot, type Snapshot } from "./snapshots";
import type { CheckinExport, Health, WorkItem } from "./sources";
import type { Sql } from "./sql";
import { ROLES } from "./store";
import type { BillingSnapshot } from "./stripe";
import {
  customerRows,
  overview,
  type TimelineEvent,
  timeline,
} from "./summary";
import { otpauthUri } from "./totp";
import {
  BROWSER_SCRIPT,
  PasskeyError,
  randomChallenge,
  registrationOptions,
  signInOptions,
  verifyRegistration,
  verifySignIn,
} from "./webauthn";

export type FirstFactor = pages.FirstFactor;

export type BoardOptions = {
  sql: Sql;
  /** "https://board.example.workers.dev": the address people open; the passkeys' relying party. */
  publicOrigin: string;
  firstFactor: FirstFactor;
  /** Cloudflare Access's signed header: required with `access`, optional extra with `passkey`. */
  access?: AccessCheck;
  now?: () => number;
  log?: (line: string) => void;
  /** Extra routes (cases, intake) tried after the board's own. */
  extensions?: Extension[];
};

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
  ) => Promise<void>;
  refuse: () => Promise<Response>;
  snapshot: <T>(source: string) => Promise<Snapshot<T>>;
};

export type Extension = {
  /** A response, or null when the path is not this extension's. */
  handle(context: Context): Promise<Response | null>;
  /** Extra timeline events for a customer (cases). */
  timeline?(customerId: string): Promise<TimelineEvent[]>;
  /** A route needing no session (a signed machine endpoint), tried before the session check. */
  handlePublic?(request: Request, url: URL): Promise<Response | null>;
};

const SESSION_COOKIE = "__Host-ark_board";
const PRE_COOKIE = "__Host-ark_board_pre";
const LANG_COOKIE = "ark_board_lang";
export const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
/** Not behind Cloudflare Access: Docker-style health, and the intake signed with its own secret. */
const ACCESS_EXEMPT = new Set(["/healthz", "/intake/app"]);

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  return respond(
    JSON.stringify(body),
    status,
    { "content-type": "application/json" },
    cookies,
  );
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
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
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
  const sql = options.sql;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const extensions = options.extensions ?? [];
  const origin = new URL(options.publicOrigin);
  const rpId = origin.hostname;
  if (options.firstFactor === "access" && !options.access) {
    throw new Error(
      "FIRST_FACTOR=access needs the Access team domain and AUD tag.",
    );
  }

  const audit = (
    actor: Pick<Account, "username" | "role"> | null,
    action: string,
    target: string | null,
    outcome: "ok" | "refused" = "ok",
    detail?: string,
  ) =>
    appendAudit(
      sql,
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

  async function services(): Promise<pages.ServiceRow[]> {
    const [checkin, relay, issues, billing] = await Promise.all([
      readSnapshot<CheckinExport>(sql, "checkins"),
      readSnapshot<Health>(sql, "relay"),
      readSnapshot<WorkItem[] | null>(sql, "issues"),
      readSnapshot<BillingSnapshot | null>(sql, "billing"),
    ]);
    const health = (snap: Snapshot<unknown>, connected: boolean): Health =>
      snap.checkedAt === null
        ? { up: null, detail: "not checked yet" }
        : snap.error
          ? { up: false, detail: snap.error }
          : connected
            ? {
                up: true,
                detail: "ok",
                ...(snap.ms !== undefined ? { ms: snap.ms } : {}),
              }
            : { up: null, detail: "not connected" };
    return [
      { name: "Check-in service (blackark.uk)", health: health(checkin, true) },
      { name: "Phone relay", health: relay.value ?? health(relay, true) },
      { name: "GitHub", health: health(issues, issues.value !== null) },
      { name: "Stripe", health: health(billing, billing.value !== null) },
    ];
  }

  function crossSite(request: Request): boolean {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return true;
    const from = request.headers.get("origin");
    return !!(from && from !== origin.origin);
  }

  async function readForm(request: Request): Promise<URLSearchParams | null> {
    if (request.method !== "POST") return null;
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > 65_536) return new URLSearchParams();
    return new URLSearchParams((await request.text()).slice(0, 65_536));
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

  /** The first factor, from a sign-in POST: who this is, or why not. */
  async function firstFactor(
    form: URLSearchParams,
    accessEmail: string | null,
  ): Promise<{
    account: Account | null;
    reason?: string;
    credential?: { id: string; count: number };
  }> {
    if (options.firstFactor === "access") {
      const account = accessEmail
        ? await findAccountByEmail(sql, accessEmail)
        : null;
      return account
        ? { account }
        : { account: null, reason: "no account for this Access email" };
    }
    const taken = await takeChallenge(
      sql,
      form.get("challengeId") ?? "",
      "sign-in",
      now(),
    );
    if (!taken) return { account: null, reason: "challenge" };
    const passkey = await findPasskey(sql, form.get("credentialId") ?? "");
    if (!passkey) return { account: null, reason: "unknown passkey" };
    const account = await findAccountById(sql, passkey.accountId);
    try {
      const count = await verifySignIn(
        {
          clientDataJSON: form.get("clientDataJSON") ?? "",
          authenticatorData: form.get("authenticatorData") ?? "",
          signature: form.get("signature") ?? "",
        },
        passkey,
        { challenge: taken.challenge, origin: origin.origin, rpId },
      );
      return { account, credential: { id: passkey.credentialId, count } };
    } catch (error) {
      return {
        account: null,
        reason:
          error instanceof PasskeyError
            ? `passkey: ${error.message}`
            : "passkey",
      };
    }
  }

  async function handlePublic(
    request: Request,
    url: URL,
    lang: Lang,
    jar: Map<string, string>,
    ipKey: string,
    accessEmail: string | null,
  ): Promise<Response | null> {
    const frame: pages.Frame = {
      lang,
      path: url.pathname,
      account: null,
      csrf: null,
    };
    const mode = options.firstFactor;

    if (
      url.pathname === "/login/options" &&
      request.method === "POST" &&
      mode === "passkey"
    ) {
      const form = (await readForm(request)) ?? new URLSearchParams();
      if (
        crossSite(request) ||
        !same(form.get("csrf") ?? "", jar.get(PRE_COOKIE) ?? "")
      ) {
        return json({ error: "csrf" }, 403);
      }
      const challenge = randomChallenge();
      const challengeId = await newChallenge(
        sql,
        "sign-in",
        null,
        challenge,
        now(),
      );
      return json({
        challengeId,
        publicKey: signInOptions({ rpId, challenge }),
      });
    }

    if (url.pathname === "/login") {
      const pre = preCsrf(jar);
      const known =
        mode === "access" && accessEmail
          ? await findAccountByEmail(sql, accessEmail)
          : null;
      if (request.method === "GET") {
        if (await findSession(sql, jar.get(SESSION_COOKIE) ?? "", now()))
          return redirect("/");
        if (mode === "access" && !known) {
          await audit(
            null,
            "sign-in",
            accessEmail,
            "refused",
            "no account for this Access email",
          );
          return respond(
            pages.messagePage(
              frame,
              t(lang, "Sign in"),
              t(
                lang,
                "This Cloudflare Access sign-in has no board account. Ask an admin.",
              ),
            ),
            403,
          );
        }
        const ended = url.searchParams.get("ended") === "1";
        return respond(
          pages.loginPage(frame, pre.value, mode, {
            error: ended
              ? t(lang, "Your session ended. Please sign in again.")
              : undefined,
            username: known?.username,
          }),
          200,
          {},
          pre.cookies,
        );
      }
      if (request.method !== "POST")
        return respond("", 405, { allow: "GET, POST" });
      const form = (await readForm(request)) ?? new URLSearchParams();
      const show = (message: string, status: number) =>
        respond(
          pages.loginPage(frame, pre.value, mode, {
            error: message,
            username: known?.username,
          }),
          status,
          {},
          pre.cookies,
        );
      if (
        crossSite(request) ||
        !same(form.get("csrf") ?? "", jar.get(PRE_COOKIE) ?? "")
      ) {
        await audit(null, "sign-in", null, "refused", "csrf");
        return show(t(lang, "The form expired. Please try again."), 403);
      }
      if ((await failures(sql, ipKey, now())) >= MAX_ADDRESS_FAILURES) {
        await audit(
          null,
          "sign-in",
          null,
          "refused",
          "too many attempts from one address",
        );
        return show(
          t(lang, "Too many attempts. Try again in 15 minutes."),
          429,
        );
      }
      const first = await firstFactor(form, accessEmail);
      const account = first.account;
      if (first.credential)
        await setSignCount(sql, first.credential.id, first.credential.count);
      const accountKey = account ? `account:${account.id}` : null;
      if (
        account &&
        accountKey &&
        (await failures(sql, accountKey, now())) >= MAX_FAILURES
      ) {
        await audit(account, "sign-in", account.username, "refused", "locked");
        return show(
          t(lang, "Too many attempts. Try again in 15 minutes."),
          429,
        );
      }
      const opened = account
        ? await finishSignIn(sql, account, form.get("code") ?? "", now())
        : null;
      if (!account || !opened) {
        await recordFailure(
          sql,
          accountKey ? [ipKey, accountKey] : [ipKey],
          now(),
        );
        await audit(
          account,
          "sign-in",
          account?.username ?? null,
          "refused",
          first.reason ?? (account ? "code" : "unknown"),
        );
        return show(
          t(
            lang,
            "That did not work. Check your passkey or code and try again.",
          ),
          401,
        );
      }
      if (accountKey) await clearFailures(sql, accountKey);
      await audit(account, "sign-in", account.username, "ok", mode);
      return redirect("/", [
        cookie(SESSION_COOKIE, opened.token, MAX_SESSION_MS / 1000),
        cookie(PRE_COOKIE, "", 0),
      ]);
    }

    const setup = url.pathname.match(
      /^\/setup\/([A-Za-z0-9_-]{43})(\/options)?$/,
    );
    if (setup) {
      const token = setup[1] as string;
      const pre = preCsrf(jar);
      const link = await findSetupLink(sql, token, now());
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
      if (setup[2]) {
        // The passkey registration's options, for webauthn.js.
        if (request.method !== "POST" || mode !== "passkey")
          return respond("", 405);
        const form = (await readForm(request)) ?? new URLSearchParams();
        if (
          crossSite(request) ||
          !same(form.get("csrf") ?? "", jar.get(PRE_COOKIE) ?? "")
        ) {
          return json({ error: "csrf" }, 403);
        }
        const challenge = randomChallenge();
        const challengeId = await newChallenge(
          sql,
          "register",
          link.account.id,
          challenge,
          now(),
        );
        return json({
          challengeId,
          publicKey: registrationOptions({
            rpId,
            rpName: "BlackArk Control Board",
            userId: `account-${link.account.id}`,
            userName: link.account.username,
            challenge,
            exclude: [],
          }),
        });
      }
      const show = (error?: string, status = 200) =>
        respond(
          pages.setupPage(
            frame,
            pre.value,
            {
              username: link.account.username,
              secret: link.totpSecret,
              uri: otpauthUri(
                "BlackArk Board",
                link.account.username,
                link.totpSecret,
              ),
              mode,
              token,
              email: link.account.access_email,
            },
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
        await audit(
          link.account,
          "account.setup",
          link.account.username,
          "refused",
          "csrf",
        );
        return show(t(lang, "The form expired. Please try again."), 403);
      }
      if ((await failures(sql, ipKey, now())) >= MAX_ADDRESS_FAILURES) {
        return show(
          t(lang, "Too many attempts. Try again in 15 minutes."),
          429,
        );
      }
      let passkey = null;
      if (mode === "passkey") {
        const taken = await takeChallenge(
          sql,
          form.get("challengeId") ?? "",
          "register",
          now(),
        );
        try {
          if (!taken || taken.accountId !== link.account.id)
            throw new PasskeyError("challenge");
          passkey = await verifyRegistration(
            {
              clientDataJSON: form.get("clientDataJSON") ?? "",
              attestationObject: form.get("attestationObject") ?? "",
            },
            { challenge: taken.challenge, origin: origin.origin, rpId },
          );
        } catch (error) {
          await recordFailure(sql, [ipKey], now());
          await audit(
            link.account,
            "account.setup",
            link.account.username,
            "refused",
            `passkey: ${(error as Error).message}`,
          );
          return show(t(lang, "The passkey was not made. Try again."), 400);
        }
      }
      const result = await completeSetup(
        sql,
        token,
        form.get("code") ?? "",
        now(),
        passkey,
        mode === "passkey",
      );
      if (!result.ok) {
        await recordFailure(sql, [ipKey], now());
        await audit(
          link.account,
          "account.setup",
          link.account.username,
          "refused",
          result.reason,
        );
        return show(
          t(
            lang,
            result.reason === "code"
              ? "That code is not right. Check your app's time and try the next code."
              : result.reason === "passkey"
                ? "The passkey was not made. Try again."
                : "This setup link is not valid. Ask an admin for a new one.",
          ),
          400,
        );
      }
      await audit(
        result.account,
        "account.setup",
        result.account.username,
        "ok",
        mode,
      );
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
    const needs = (permission: Permission) => can(role, permission);
    const checkins = () => context.snapshot<CheckinExport>("checkins");
    const banner = (snap: Snapshot<unknown>) =>
      pages.staleBanner(lang, snap.fetchedAt, snap.error);

    if (path === "/logout" && method === "POST") {
      await endSession(sql, session.tokenHash);
      await context.audit("sign-out", session.account.username);
      return redirect("/login", [cookie(SESSION_COOKIE, "", 0)]);
    }

    if (method === "GET" && path === "/") {
      const [data, billing] = await Promise.all([
        checkins(),
        context.snapshot<BillingSnapshot | null>("billing"),
      ]);
      await context.audit("view", "overview");
      return respond(
        pages.overviewPage(
          frame,
          data.value ? overview(data.value, context.now) : null,
          await services(),
          banner(data),
          billing.value?.failed.length ?? null,
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
      await context.audit("view", "customers", "ok", known ?? undefined);
      const rows = data.value ? customerRows(data.value, context.now) : [];
      return respond(
        pages.customersPage(
          frame,
          pages.filterCustomers(rows, known),
          known,
          banner(data),
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
      await context.audit("view", `customer:${id}`);
      const rows = data.value ? customerRows(data.value, context.now) : [];
      const extra = (
        await Promise.all(
          extensions.map((one) => one.timeline?.(id) ?? Promise.resolve([])),
        )
      ).flat();
      const events = data.value ? timeline(data.value, id, extra) : extra;
      return respond(
        pages.customerPage(
          frame,
          id,
          rows.find((row) => row.customerId === id) ?? null,
          events,
          banner(data),
          extensions.length > 0 && needs("cases.write"),
        ),
      );
    }

    if (method === "GET" && path === "/billing") {
      await context.audit("view", "billing");
      const result = await context.snapshot<BillingSnapshot | null>("billing");
      return respond(pages.billingPage(frame, result.value, result.error));
    }

    if (method === "GET" && path === "/services") {
      await context.audit("view", "services");
      return respond(pages.servicesPage(frame, await services()));
    }

    if (method === "GET" && path === "/issues") {
      await context.audit("view", "issues");
      const result = await context.snapshot<WorkItem[] | null>("issues");
      return respond(pages.issuesPage(frame, result.value, result.error));
    }

    if (method === "GET" && path === "/audit") {
      if (!needs("audit.read")) return context.refuse();
      const perPage = 100;
      const total = await countAudit(sql);
      const pagesCount = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(
        pagesCount,
        Math.max(
          1,
          Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
        ),
      );
      await context.audit(
        "view",
        "audit",
        "ok",
        page > 1 ? `page ${page}` : undefined,
      );
      const chain = await context.snapshot<{ brokenAt: number | null }>(
        "audit-chain",
      );
      return respond(
        pages.auditPage(
          frame,
          await readAudit(sql, perPage, (page - 1) * perPage),
          page,
          pagesCount,
          chain.value && chain.checkedAt !== null
            ? { brokenAt: chain.value.brokenAt, checkedAt: chain.checkedAt }
            : null,
        ),
      );
    }

    if (path === "/accounts") {
      if (!needs("accounts.manage")) return context.refuse();
      const manageable = ROLES.filter((target) => canManage(role, target));
      const withEmail = options.firstFactor === "access";
      const show = async (
        message?: { setupLink?: string; username?: string; error?: string },
        status = 200,
      ) =>
        respond(
          pages.accountsPage(
            frame,
            await listAccounts(sql),
            [...manageable],
            (account) =>
              canManage(role, account.role) &&
              account.id !== session.account.id,
            message,
            withEmail,
          ),
          status,
        );
      if (method === "GET") {
        await context.audit("view", "accounts");
        return show();
      }
      if (method !== "POST") return respond("", 405, { allow: "GET, POST" });
      const form = context.form ?? new URLSearchParams();
      const action = form.get("action") ?? "";
      const username = (form.get("username") ?? "").trim().toLowerCase();
      const link = (token: string) => `${origin.origin}/setup/${token}`;
      if (action === "create") {
        const wanted = form.get("role") ?? "";
        if (!validRole(wanted) || !canManage(role, wanted)) {
          await context.audit(
            "account.create",
            username,
            "refused",
            `role ${wanted}`,
          );
          return context.refuse();
        }
        const email = withEmail
          ? (form.get("email") ?? "").trim().toLowerCase()
          : null;
        try {
          const token = await createPendingAccount(
            sql,
            { username, role: wanted, accessEmail: email },
            session.account.username,
            context.now,
          );
          await context.audit(
            "account.create",
            username,
            "ok",
            `role ${wanted}`,
          );
          return show({ setupLink: link(token), username });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          await context.audit("account.create", username, "refused", reason);
          const messages: Record<string, string> = {
            taken: "That user name is taken.",
            "email-taken": "That email already has an account.",
            "bad-email": "That email address is not valid.",
          };
          return show(
            {
              error: t(
                lang,
                messages[reason] ?? "That user name is not valid.",
              ),
            },
            400,
          );
        }
      }
      if (action === "reset" || action === "disable") {
        const target = await findAccount(sql, username);
        if (!target) return show({ error: t(lang, "No such account.") }, 404);
        if (!canManage(role, target.role) || target.id === session.account.id) {
          await context.audit(
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
          (await activeOwners(sql)) <= 1
        ) {
          await context.audit(
            `account.${action}`,
            username,
            "refused",
            "last owner",
          );
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
          await disableAccount(sql, target);
          await context.audit("account.disable", username);
          return show();
        }
        const token = await resetAccount(sql, target, context.now);
        await context.audit("account.reset", username);
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
    /** `ip` is the caller's address (Cloudflare's Cf-Connecting-Ip); only its hash is kept, 15 minutes, for sign-in limits. */
    async fetch(request: Request, ip = "unknown"): Promise<Response> {
      const url = new URL(request.url);
      const jar = readCookies(request);
      const lang: Lang = jar.get(LANG_COOKIE) === "el" ? "el" : "en";

      let accessEmail: string | null = null;
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
        accessEmail = passed.email;
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
      if (url.pathname === "/webauthn.js") {
        return new Response(BROWSER_SCRIPT, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
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

      const ipKey = `ip:${sha256(ip)}`;
      const open = await handlePublic(
        request,
        url,
        lang,
        jar,
        ipKey,
        accessEmail,
      );
      if (open) return open;
      for (const extension of extensions) {
        const answer = await extension.handlePublic?.(request, url);
        if (answer) return answer;
      }

      const session = await findSession(
        sql,
        jar.get(SESSION_COOKIE) ?? "",
        now(),
      );
      // Behind Access, the session must belong to the person Access let through.
      if (
        !session ||
        (options.firstFactor === "access" &&
          session.account.access_email !== accessEmail)
      ) {
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
        refuse: async () => {
          await audit(
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
        snapshot: (source) => readSnapshot(sql, source),
      };
      if (request.method === "POST") {
        if (
          crossSite(request) ||
          !same(form?.get("csrf") ?? "", session.csrf)
        ) {
          await audit(
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
