import type { Context, MiddlewareHandler } from "hono";
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";

/**
 * What a change to the team or to how staff reach it writes to the audit trail (security review of
 * v0.1.54, F6), told by the route it went to. Only changes that went through are written: a refused
 * one is somebody else's row (a wrong password is `session.refused`).
 */
export function teamAuditEvent(
  method: string,
  path: string,
): { eventType: AuditEventType; targetType: string; targetId?: string } | null {
  const member = /^\/api\/team\/members\/([^/]+)(\/agents)?$/.exec(path);
  if (method === "POST" && path === "/api/team/setup")
    return { eventType: "team.administrator_made", targetType: "team" };
  if (method === "POST" && path === "/api/team/members")
    return { eventType: "team.member_added", targetType: "team" };
  if (method === "DELETE" && member && !member[2])
    return {
      eventType: "team.member_removed",
      targetType: "person",
      targetId: decodeURIComponent(member[1] as string),
    };
  if (method === "PUT" && member?.[2])
    return {
      eventType: "team.member_agents_changed",
      targetType: "person",
      targetId: decodeURIComponent(member[1] as string),
    };
  if (
    method === "POST" &&
    (path === "/api/team/me/password" || path === "/api/auth/change-password")
  )
    return { eventType: "team.password_changed", targetType: "person" };
  if (method === "POST" && path === "/api/team/billing/sync")
    return { eventType: "team.billing_synced", targetType: "team" };
  if (method === "PUT" && path === "/api/team/office")
    return { eventType: "office.settings_changed", targetType: "office" };
  if (method === "POST" && path === "/api/team/office/join-code")
    return { eventType: "office.join_code_renewed", targetType: "office" };
  return null;
}

/** Which of the request's fields are safe to keep: switches and employee ids, never a password. */
const KEPT = ["enabled", "remote", "agentIds", "name", "email"] as const;

export function teamAudit(options: {
  auditStore: AuditStore;
  /** The signed-in person, when there is one (set-up has none yet). */
  actorOf: (context: Context) => Promise<string | null>;
}): MiddlewareHandler {
  return async (context, next) => {
    const url = new URL(context.req.url);
    const event = teamAuditEvent(context.req.method, url.pathname);
    if (!event) return next();
    const body = (await context.req.raw
      .clone()
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    // Before the change: a password change ends the session it came with.
    const actor = await options.actorOf(context).catch(() => null);
    await next();
    if (context.res.status >= 300) return;
    const payload: Record<string, unknown> = {};
    for (const key of KEPT) if (key in body) payload[key] = body[key];
    await recordAuditEvent(options.auditStore, {
      ...event,
      ...(event.targetType === "person" && !event.targetId && actor
        ? { targetId: actor }
        : {}),
      ...(actor ? { actorUserId: actor } : {}),
      payload,
    }).catch((error: unknown) =>
      console.error(
        JSON.stringify({
          type: "team-audit-write-failed",
          eventType: event.eventType,
          error: String(error),
        }),
      ),
    );
  };
}
