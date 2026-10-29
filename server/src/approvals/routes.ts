import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { approvalDetails, CHAT_CARD_KIND, type ChatCardPayload } from "./held";
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalStore,
} from "./store";

/**
 * The inbox: everything that is waiting for the person, and the two answers.
 *
 * Owner-scoped through the store on every call. There is no way to read, approve or reject a request
 * that belongs to somebody else, and an id that is not theirs reads exactly like one that does not
 * exist. The payload itself is never sent to the browser: the summary says what will happen, and the
 * details beside it are drawn from the payload by the server (`approvalDetails`) — for a held call,
 * its exact arguments, because what the person approves is what runs.
 */
export function createApprovalRoutes(
  store: ApprovalStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Whether the person may act as the digital employee a chat card names. Absent refuses cards. */
  canUseBot?: BotAccessCheck,
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

  /*
   * An approval card a digital employee raised in a conversation, registered by the browser drawing
   * it so it is listed with everything else that needs the person (desk #69).
   *
   * Idempotent on the card's tool call: a card is drawn again on every reload, and the second
   * registration answers with the first row, decided or not — which is how a card learns it was
   * already answered from the list.
   */
  routes.post("/cards", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const text = (value: unknown, max: number) =>
      typeof value === "string" && value.trim()
        ? value.trim().slice(0, max)
        : null;
    const toolCallId = text(body?.toolCallId, 200);
    const agentId = text(body?.agentId, 200);
    const title = text(body?.title, 200);
    if (!toolCallId || !agentId || !title) {
      return context.json(
        {
          error:
            "A card needs its tool call, its digital employee and a title.",
        },
        400,
      );
    }
    if (!canUseBot || !(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such digital employee." }, 404);
    }
    const details = Array.isArray(body?.details)
      ? (body.details as unknown[])
          .filter(
            (row): row is { label: unknown; value: unknown } =>
              typeof row === "object" && row !== null,
          )
          .slice(0, 20)
          .map((row) => ({
            label: String(row.label ?? "").slice(0, 120),
            value: String(row.value ?? "").slice(0, 1000),
          }))
      : [];
    const channelId = text(body?.channelId, 200);
    const payload: ChatCardPayload = {
      title,
      summary: text(body?.summary, 500) ?? "",
      details,
      toolCallId,
      ...(channelId ? { channelId } : {}),
    };
    try {
      const record = await store.request({
        ownerUserId: context.var.actor.id,
        requestedByAgentId: agentId,
        kind: CHAT_CARD_KIND,
        targetId: toolCallId,
        summary: payload.summary ? `${title}: ${payload.summary}` : title,
        payload,
        key: toolCallId,
      });
      return context.json({ approval: dto(record) });
    } catch (error) {
      if (error instanceof ApprovalRefusedError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  routes.get("/:id", requireUser, async (context) => {
    const record = await store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!record) {
      return context.json({ error: "There is no such approval." }, 404);
    }
    return context.json({ approval: dto(record) });
  });

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
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const cardChannel =
    record.kind === CHAT_CARD_KIND && typeof payload.channelId === "string"
      ? payload.channelId
      : null;
  return {
    id: record.id,
    kind: record.kind,
    summary: record.summary,
    details: approvalDetails(record),
    status: record.status,
    result: record.result,
    requestedBy: {
      id: record.requestedByAgentId,
      name: record.requestedByName,
    },
    target: record.targetAgentId
      ? { id: record.targetAgentId, name: record.targetAgentName }
      : null,
    // Where it was asked, for a link back to the conversation. Null when it was asked in none.
    channelId: record.channelId ?? cardChannel,
    // The card's own tool call, so the chat can find the row that belongs to a card.
    toolCallId:
      record.kind === CHAT_CARD_KIND && typeof payload.toolCallId === "string"
        ? payload.toolCallId
        : null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt,
  };
}
