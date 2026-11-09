/**
 * `POST /api/team-fanout/:channelId`: the person asks several colleagues in one message (desk #87).
 *
 * The browser calls this just before it sends the message to the channel's lead, and tells the lead
 * who was asked. It is a route of its own rather than a step inside the lead's run because the run
 * belongs to one agent and one runtime, and the person asking several colleagues is neither: the
 * question is whose channel this is and who is in it, which the channel store answers for the person
 * signed in, and nothing the browser says about either is taken on trust.
 *
 * Only mounted when `TEAM_FANOUT_ENABLED` is on.
 */
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { mintRunAssertion, readRunAssertion } from "../agents/callback-token";
import { fanOut } from "../agents/fanout";
import type { HandoffDesk } from "../agents/handoff";
import type { AuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "./routes";

const body = z.object({
  /** The channel's lead, whose run the hops are counted under. */
  leadId: z.string().trim().min(1).max(200),
  /** The colleagues the person named, by id. More than the cap is refused by the desk, in order. */
  targets: z.array(z.string().trim().min(1).max(200)).min(2).max(50),
  /** What the person wrote, verbatim. */
  text: z.string().trim().min(1).max(20_000),
});

export function createFanoutRoutes(options: {
  channels: ChannelStore;
  desk: HandoffDesk;
  auditStore: AuditStore;
  encryptionKey: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const { channels, desk, auditStore, encryptionKey, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:channelId", requireUser, async (context) => {
    const parsed = body.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(
        { error: "Say which colleagues, and what you are asking them." },
        400,
      );
    }
    const actor = context.var.actor;
    // The person's own channel or none: another person's channel reads as not found.
    const channel = await channels.get(actor, context.req.param("channelId"));
    if (!channel) return context.json({ error: "Channel not found." }, 404);

    const members = new Set(channel.agentIds);
    const { leadId, targets, text } = parsed.data;
    if (!members.has(leadId)) {
      return context.json(
        { error: "That digital employee is not in this channel." },
        400,
      );
    }
    const outside = targets.filter((target) => !members.has(target));
    if (outside.length > 0) {
      return context.json(
        {
          error:
            "Only colleagues in this channel can be asked together. Add them to it first.",
        },
        400,
      );
    }

    /*
     * The lead's run, as this deployment states it: signed and read back, so the hops carry exactly
     * what a run of the lead's would. A fresh run id, because this is one message of the person's and
     * the cap counts fan-out hops per run; the channel's thread, because that is where the answers
     * land.
     */
    const run = readRunAssertion(
      mintRunAssertion(
        {
          botId: leadId,
          actorId: actor.id,
          runId: randomUUID(),
          threadId: channel.threadId,
        },
        encryptionKey,
      ),
      encryptionKey,
    );
    if (!run) {
      return context.json({ error: "This could not be sent just now." }, 500);
    }

    const outcome = await fanOut({
      desk,
      run,
      targets,
      task: text,
      auditStore,
    });
    return context.json(outcome);
  });

  return routes;
}
