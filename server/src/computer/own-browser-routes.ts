/**
 * The person's own browser: what the desktop announces, and what the person chooses (device control).
 *
 * Two kinds of caller, kept apart:
 *  - the DESKTOP APP, with the bearer token only it and this server process were given at start
 *    (`OPENBOT_DESKTOP_HOST_TOKEN`, the same one folder access uses), saying whether the person's
 *    browser is switched on and where it is driven from;
 *  - a SIGNED-IN PERSON, choosing which of their digital employees work in that browser, seeing which
 *    one is driving it, and stopping it.
 *
 * Nothing a person sends here can switch the browser on. That is the desktop's alone, in its own
 * native menu, so a page or a digital employee cannot talk its way into somebody's browser.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { desktopAuthorized } from "../host-access/routes";
import {
  closeOwnBrowserTab,
  OWN_BROWSER_LEASE_MS,
  type OwnBrowser,
  ownBrowserAddress,
} from "./own-browser";

/** The local desktop actor, which is not a row in `users`. See computer/routes.ts. */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

export const SWITCH_IT_ON_FIRST =
  "Your own browser is switched off. Switch on “Let digital employees use my browser” in the ArkAgent desktop app first.";

export function createOwnBrowserRoutes(options: {
  own: OwnBrowser;
  desktopToken?: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  auditStore?: AuditStore;
  /** The computer token, for closing an employee's tab in the person's browser. */
  computerToken?: string;
  /**
   * Forget the snapshot an employee's refs resolve against.
   *
   * Moving an employee between computers leaves the last page it saw on the other one. Its refs must
   * not resolve against a page in a different browser, so the row goes when the choice changes.
   */
  forgetSnapshot?: (botId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { own, requireUser, canUseBot } = options;
  const callOptions = {
    ...(options.computerToken ? { token: options.computerToken } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  const audit = async (
    change: string,
    detail: { actor?: AppVariables["actor"]; botId?: string },
  ) => {
    if (!options.auditStore) return;
    const { actor, botId } = detail;
    await recordAuditEvent(options.auditStore, {
      eventType: "configuration.changed",
      targetType: "own_browser",
      ...(botId ? { targetId: botId } : {}),
      // Only a real users row may go in the foreign key column; the local desktop actor is not one.
      // Who it was is in the payload either way. Same rule as the computer routes.
      ...(actor && actor.email !== DEV_ACTOR_EMAIL
        ? { actorUserId: actor.id }
        : {}),
      payload: {
        change,
        ...(botId ? { bot: botId } : {}),
        ...(actor ? { actor: actor.id } : {}),
      },
    });
  };

  const requireDesktop: MiddlewareHandler = async (context, next) => {
    const token = options.desktopToken;
    if (!token) {
      return context.json(
        { error: "This deployment is not running in the desktop app." },
        503,
      );
    }
    if (!desktopAuthorized(context.req.raw, token)) {
      return context.json({ error: "Desktop authentication failed." }, 401);
    }
    await next();
  };

  /**
   * The desktop, every few seconds while the switch is on, and once with `null` when it goes off.
   *
   * The repetition is the point: a desktop that crashed, or a browser the person closed, stops
   * announcing, and the lease running out takes the browser away without anybody having to say so.
   */
  routes.put("/desktop", requireDesktop, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      url?: unknown;
    } | null;
    if (!body || !("url" in body)) {
      return context.json({ error: "Send { url } or { url: null }." }, 400);
    }
    let url: string | null = null;
    if (body.url !== null) {
      url = ownBrowserAddress(body.url);
      if (!url) {
        return context.json(
          {
            error:
              "The person's browser is driven from this computer's loopback address and nowhere else.",
          },
          400,
        );
      }
    }
    const released = url === null ? own.status().employees : [];
    const { switched } = own.announce(url);
    if (switched) {
      await audit(
        switched === "on"
          ? "own_browser_switched_on"
          : "own_browser_switched_off",
        {},
      );
    }
    for (const choice of released) {
      await options.forgetSnapshot?.(choice.botId).catch(() => undefined);
    }
    return context.json({ ok: true, leaseMs: OWN_BROWSER_LEASE_MS });
  });

  /** What the person may see: the switch, and their own employees that are pointed at it. */
  const statusFor = async (actor: AppVariables["actor"]) => {
    const status = own.status();
    const employees = [];
    for (const choice of status.employees) {
      if (await canUseBot(actor, choice.botId)) employees.push(choice);
    }
    return {
      // Whether this deployment can have an own browser at all: only the desktop app can.
      desktop: Boolean(options.desktopToken),
      available: status.available,
      employees,
    };
  };

  routes.get("/", requireUser, async (context) =>
    context.json(await statusFor(context.var.actor)),
  );

  /** Point one digital employee at the person's browser, or back at its own computer. */
  routes.put("/employees/:botId", requireUser, async (context) => {
    const botId = context.req.param("botId").trim();
    const body = (await context.req.json().catch(() => null)) as {
      use?: unknown;
    } | null;
    if (!botId || typeof body?.use !== "boolean") {
      return context.json(
        { error: "Send { use: true } or { use: false }." },
        400,
      );
    }
    const actor = context.var.actor;
    if (!(await canUseBot(actor, botId))) {
      return context.json(
        { error: "That digital employee is not available to you." },
        404,
      );
    }
    if (body.use) {
      if (!own.available()) {
        return context.json({ error: SWITCH_IT_ON_FIRST }, 409);
      }
      if (!own.chosen(botId)) {
        own.choose(botId, actor.id);
        await options.forgetSnapshot?.(botId).catch(() => undefined);
        await audit("own_browser_chosen", { actor, botId });
      }
    } else if (own.chosen(botId)) {
      // Its tab goes with it: the person said this employee no longer works in their browser.
      await closeOwnBrowserTab(own, botId, callOptions);
      own.release(botId);
      await options.forgetSnapshot?.(botId).catch(() => undefined);
      await audit("own_browser_released", { actor, botId });
    }
    return context.json(await statusFor(actor));
  });

  /**
   * Stop: every digital employee out of the person's browser, now, and their tabs closed.
   *
   * The control on the "driving your browser" indicator. Not a takeover, which keeps the employee
   * waiting while the person drives; this ends it. The browser itself stays open, because it is the
   * person's window and they may be in the middle of something in it.
   */
  routes.post("/stop", requireUser, async (context) => {
    const actor = context.var.actor;
    const employees = own.status().employees;
    for (const choice of employees) {
      if (!(await canUseBot(actor, choice.botId))) continue;
      await closeOwnBrowserTab(own, choice.botId, callOptions);
      own.release(choice.botId);
      await options.forgetSnapshot?.(choice.botId).catch(() => undefined);
    }
    await audit("own_browser_stopped", { actor });
    return context.json(await statusFor(actor));
  });

  return routes;
}
