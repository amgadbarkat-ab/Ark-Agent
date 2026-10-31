/**
 * A message the person sent to several colleagues at once (desk #87): one hop each, asked by the
 * deployment rather than by the lead's model.
 *
 * Without this a team channel reaches colleagues only through the lead, which is told who the
 * message was for and passes it on with `team_ask` — one colleague per message, and only when the
 * model does it, which a small local model sometimes does not. Here the person's own words go to
 * each colleague they named, every hop through the same desk `team_ask` uses, so the caps, the
 * grants and the audit trail are the ones that already hold.
 *
 * Each hop is marked `fanout`. A colleague answering one hands nothing on (the desk refuses it), and
 * none of them gets the person's own browser: a hop runs with no browser-side tools at all, and the
 * browser-side tools are the only way to it.
 */
import { type AuditStore, recordAuditEvent } from "../audit";
import type { RunAssertion } from "./callback-token";
import type { HandoffDesk } from "./handoff";

export type FanoutOutcome = {
  /** The colleagues a hop was queued for, by id, in the order the person named them. */
  asked: string[];
  /** The ones that were not, with the desk's sentence for each. */
  refused: Array<{ target: string; refusal: string }>;
};

export async function fanOut(input: {
  desk: HandoffDesk;
  /** The lead's run, as this deployment signed it: who is asking, for whom, and in which thread. */
  run: RunAssertion;
  /** The colleagues the person named, by id. Repeats and the lead itself are dropped. */
  targets: readonly string[];
  /** What the person wrote, verbatim. */
  task: string;
  auditStore: AuditStore;
}): Promise<FanoutOutcome> {
  const { desk, run, task, auditStore } = input;
  const targets = [...new Set(input.targets.map((target) => target.trim()))]
    .filter(Boolean)
    .filter((target) => target !== run.botId);

  const outcome: FanoutOutcome = { asked: [], refused: [] };
  // One at a time and in order, so the cap refuses the last names rather than whichever raced.
  for (const target of targets) {
    const sent = await desk.send({
      from: run,
      target,
      envelope: { task, fanout: true },
    });
    if (sent.ok) outcome.asked.push(sent.to);
    else outcome.refused.push({ target, refusal: sent.refusal });
  }

  await recordAuditEvent(auditStore, {
    eventType: "team.fanout",
    targetType: "agent",
    targetId: run.botId,
    actorUserId: run.actorId,
    ...(run.initiator ? { initiator: run.initiator } : {}),
    payload: {
      bot: run.botId,
      run: run.runId,
      // Ids only. The person's words are in the conversation, where the person can see them.
      asked: outcome.asked,
      refused: outcome.refused.map((entry) => entry.target.slice(0, 120)),
    },
  });
  return outcome;
}
