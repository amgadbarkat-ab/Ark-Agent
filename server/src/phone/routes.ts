import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import {
  type ActiveCall,
  type PhoneApprovals,
  type PhoneRefusal,
  PhoneSettingsError,
} from "./service";

/**
 * Approving by phone (P2 idea 10). Mounted only when `PHONE_APPROVAL_ENABLED=true`.
 *
 * `/settings` is the person's own number, PIN and employees. `/call/:approvalId` rings them about
 * one request. `/calls` and the three call actions are the simulated phone, which rings inside the
 * app until a real provider has Amgad's yes.
 */
const REFUSALS: Record<PhoneRefusal, string> = {
  "device-control":
    "Browser and computer actions are never approved by phone. Approve it in the app.",
  payment:
    "Anything that moves money is never approved by phone. Approve it in the app.",
  kind: "This kind of request is approved in the app only.",
  "not-pending": "This request is no longer waiting.",
  "off-for-employee":
    "Phone approval is not on for this digital employee. Turn it on under Settings, then Phone approval.",
  "no-settings":
    "Set your number and PIN under Settings, then Phone approval, first.",
};

const settingsBody = z.object({
  phone: z.string().max(40),
  pin: z.string().max(8).optional(),
  agentIds: z.array(z.string().max(200)).max(50),
});

/** What the app shows of a call: never the PIN, and the summary only once the PIN was right. */
function callDto(call: ActiveCall) {
  return {
    id: call.id,
    approvalId: call.approvalId,
    step: call.state.step,
    outcome: call.state.step === "ended" ? call.state.outcome : null,
    said: call.said,
    startedAt: call.startedAt.toISOString(),
  };
}

export function createPhoneRoutes(options: {
  phone: PhoneApprovals;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const { phone, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/settings", requireUser, async (context) =>
    context.json({
      provider: phone.providerName,
      ...(await phone.settings(context.var.actor.id)),
    }),
  );

  routes.put("/settings", requireUser, async (context) => {
    const parsed = settingsBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Give a number, a PIN and employees." },
        400,
      );
    }
    try {
      return context.json(
        await phone.saveSettings(context.var.actor.id, {
          phone: parsed.data.phone,
          agentIds: parsed.data.agentIds,
          ...(parsed.data.pin ? { pin: parsed.data.pin } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof PhoneSettingsError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.post("/call/:approvalId", requireUser, async (context) => {
    const outcome = await phone.callAbout(
      context.var.actor.id,
      context.req.param("approvalId"),
    );
    if ("refused" in outcome) {
      return context.json({ error: REFUSALS[outcome.refused] }, 409);
    }
    return context.json({ call: callDto(outcome.call) }, 201);
  });

  routes.get("/calls", requireUser, async (context) =>
    context.json({
      calls: (await phone.active(context.var.actor.id)).map(callDto),
    }),
  );

  routes.post("/calls/:callId/answer", requireUser, async (context) => {
    const call = await phone.answer(
      context.var.actor.id,
      context.req.param("callId"),
    );
    return call
      ? context.json({ call: callDto(call) })
      : context.json({ error: "No such call." }, 404);
  });

  routes.post("/calls/:callId/keys", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      keys?: unknown;
    } | null;
    const keys = typeof body?.keys === "string" ? body.keys : "";
    if (!/^[0-9#*]{1,9}$/.test(keys)) {
      return context.json({ error: "Press digits, * or #." }, 400);
    }
    const call = await phone.press(
      context.var.actor.id,
      context.req.param("callId"),
      keys,
    );
    return call
      ? context.json({ call: callDto(call) })
      : context.json({ error: "No such call." }, 404);
  });

  routes.post("/calls/:callId/hang-up", requireUser, async (context) => {
    await phone.hangUp(context.var.actor.id, context.req.param("callId"));
    return context.body(null, 204);
  });

  return routes;
}
