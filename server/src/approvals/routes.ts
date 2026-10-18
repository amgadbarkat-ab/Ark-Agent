import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  type ApprovalRecord,
  type ApprovalStore,
} from "./store";

/**
 * The inbox: what the person's digital employees have asked to change, and the two answers.
 *
 * Owner-scoped through the store on every call. There is no way to read, approve or reject a request
 * that belongs to somebody else, and an id that is not theirs reads exactly like one that does not
 * exist. The payload is never sent to the browser: the summary says what will change, and it is
 * written by the code that built the payload, not by the model.
 */
export function createApprovalRoutes(
  store: ApprovalStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const which = context.req.query("which") === "all" ? "all" : "pending";
    const owner = context.var.actor.id;
    const [list, pending] = await Promise.all([
      store.list(owner, which),
      store.pendingCount(owner),
    ]);
    return context.json({ approvals: list.map(dto), pending });
  });

  routes.get("/count", requireUser, async (context) =>
    context.json({ pending: await store.pendingCount(context.var.actor.id) }),
  );

  for (const decision of ["approve", "reject"] as const) {
    routes.post(`/:id/${decision}`, requireUser, async (context) => {
      const id = context.req.param("id");
      if (!id.trim()) {
        return context.json({ error: "An approval id is required." }, 400);
      }
      try {
        const record = await store.decide(context.var.actor.id, id, decision);
        return context.json({ approval: dto(record) });
      } catch (error) {
        if (error instanceof ApprovalNotFoundError) {
          return context.json({ error: error.message }, 404);
        }
        if (error instanceof ApprovalNotPendingError) {
          return context.json({ error: error.message }, 409);
        }
        throw error;
      }
    });
  }

  return routes;
}

function dto(record: ApprovalRecord) {
  return {
    id: record.id,
    kind: record.kind,
    summary: record.summary,
    status: record.status,
    result: record.result,
    requestedBy: {
      id: record.requestedByAgentId,
      name: record.requestedByName,
    },
    target: record.targetAgentId
      ? { id: record.targetAgentId, name: record.targetAgentName }
      : null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt,
  };
}
