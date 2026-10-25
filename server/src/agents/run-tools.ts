/**
 * What a run gets, built for that run: the team tools, handing work to another Bot, and asking a person.
 *
 * Out of `index.ts` so it can be tested. The team tools were missing from here until v0.1.15, and a
 * built-in employee's `team_ask` then had no run to ask as: every one was refused, and the DT Lab's
 * lead (v0.1.14) told the person it could not reach its colleagues. Nothing caught it because this
 * lived inline in the server's wiring, where no test reached.
 */
import type { RunAgentInput } from "@ag-ui/client";
import { type AuditStore, PERSON_INITIATOR } from "../audit";
import type { GrantedTool } from "../plugins/tools";
import { readRunAssertion } from "./callback-token";
import { askTheirOwnPerson, escalationTool } from "./escalation";
import type { HandoffDesk } from "./handoff";
import { handoffTool } from "./handoff-tool";
import { type TeamToolDependencies, teamTools } from "./team-tools";

export type RunToolDependencies = {
  keyEncryptionKey: string;
  handoff: { maxDepth: number; maxPerRun: number };
  desk: HandoffDesk;
  /** The Bots this one has been granted, read per run. */
  botsReachableFrom: (botId: string) => Promise<string[]>;
  auditStore?: AuditStore;
  team: TeamToolDependencies;
};

export function createRunTools(
  deps: RunToolDependencies,
): (
  actorId: string,
) => (botId: string, input: RunAgentInput) => Promise<GrantedTool[]> {
  return (actorId) => async (botId, input) => {
    const from = readRunAssertion(
      (input.forwardedProps as { openbotRun?: unknown } | undefined)
        ?.openbotRun,
      deps.keyEncryptionKey,
    );
    const run = {
      botId,
      actorId,
      runId: input.runId,
      threadId: input.threadId,
      depth: from?.depth ?? 0,
      // Read from the assertion for the reason `depth` is: the run is rebuilt from parts here, and
      // a field left out of this object is a field the desk and the escalation never see.
      initiator: from?.initiator ?? PERSON_INITIATOR,
      // And the request the chain descends from, for the cap that holds a whole chain to one number.
      ...(from?.request ? { request: from.request } : {}),
    };
    /*
     * The caps are checked BEFORE the grants query, not inside the tool that would discard it.
     *
     * `handoffTool` short-circuits on all three of these, but only after being handed a
     * `hasSomebodyToAsk` that costs a query. So a deployment which switched the capability off
     * still paid one grants read per run of every Bot, for a tool it was never going to be offered,
     * and a run already at the cap paid it again.
     */
    const couldHandOn =
      deps.handoff.maxDepth > 0 &&
      deps.handoff.maxPerRun > 0 &&
      run.depth < deps.handoff.maxDepth;

    const passing = couldHandOn
      ? handoffTool({
          desk: deps.desk,
          /*
           * How deep this run already is comes from the assertion the deployment signed when it handed
           * this work on. A run a person started carries none, and none means zero.
           *
           * NOT `from.botId`. The assertion proves what this run is, and the Bot is whichever one the
           * runtime is building right now: on a hop those agree, and taking the id from the signed
           * value rather than from the build would let a stale assertion aim the next hop at the
           * wrong Bot's grants.
           */
          from: run,
          // Read now rather than at boot, so a grant made a minute ago counts and one revoked a
          // minute ago stops counting.
          hasSomebodyToAsk:
            (await deps.botsReachableFrom(botId).catch(() => [] as string[]))
              .length > 0,
          maxDepth: deps.handoff.maxDepth,
          maxPerRun: deps.handoff.maxPerRun,
        })
      : null;
    /*
     * The way to stop and ask is offered whether or not there is a Bot to hand to.
     *
     * It is the cheaper of the two and the one a Bot should reach for first: asking the person who
     * is already in the conversation spends nothing and cannot be aimed anywhere they cannot see.
     * A deployment that offered only the expensive exit would push every unanswerable question
     * sideways into another run.
     */
    const asking = escalationTool({
      from: run,
      route: askTheirOwnPerson,
      auditStore: deps.auditStore,
    });
    /*
     * The team tools again, this time knowing the run.
     *
     * Asking a colleague goes through the desk as this run, so `team_ask` needs the run as much as
     * the hand-off above does. Built per request (`loadToolsForActor`) it has none, and a built-in
     * employee's every `team_ask` was refused with "asking a colleague works from a conversation":
     * the DT Lab's lead (v0.1.14) then told the person it could not reach its colleagues and did the
     * work itself. A Bot at an endpoint was never affected, because its calls come back through the
     * tool callback with the run attached. These replace the request's copies of the same names.
     */
    const team = await teamTools({
      deps: deps.team,
      botId,
      actorId,
      run,
    });
    return [...team, ...(passing ? [passing] : []), asking];
  };
}
