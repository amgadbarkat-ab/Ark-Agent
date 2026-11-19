/**
 * Ark Team's agent limit on this install (v0.1.49; Amgad, 19 Nov): agents per seat times seats.
 *
 * WHERE THE NUMBER COMES FROM (the activation service works it out, `agentLimit` on its view):
 * - a paid licence key: its signed `maxAgents` (5, 10 or 20; absent on older keys, counted as 5)
 *   times its `seats`;
 * - the trial setup file: the size of its signed roster, or 5 when it names nobody;
 * - a trial activation code: 5;
 * - ArkAgent, Enterprise, the internal plan, and an install with nothing (hosted, dev, CI): no limit.
 *
 * WHAT IS COUNTED: every digital employee a person made on this install and nobody deleted, hidden
 * or not (hiding is one person's view). The deployment's own built-in employees have no owner and are
 * not counted.
 *
 * NOTHING EXISTING IS TOUCHED. An install above its limit (after a downgrade, or a seat removed)
 * keeps every employee, and every one keeps running; it only cannot add another. The refusal is the
 * whole of the enforcement: on the store (trial/guard.ts), so every way of making one is held to it.
 *
 * Seeding the signed trial roster is not refused: the roster is where a trial's limit comes from.
 */
import { and, count, isNotNull, isNull } from "drizzle-orm";
import { type AgentLimitNotice, agentLimitNotice } from "../../../shared/plans";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import type { ActivationView } from "./activation";

export type AgentAllowance = {
  /** How many digital employees this install may have. Null: no limit. */
  limit: number | null;
  /** How many it has now. */
  inUse: number;
  /** Whether one more may be made. */
  canAdd: boolean;
  agentsPerSeat: number | null;
  seats: number | null;
  /** The sentence to show while it cannot add, in English and Greek. Null while it can. */
  notice: AgentLimitNotice | null;
};

/** Which way somebody tried to add one, for the audit row. */
export type AgentAddPath = "create" | "duplicate" | "marketplace";

export class AgentLimitReachedError extends Error {
  readonly notice: AgentLimitNotice;
  readonly code = "agent_limit_reached";
  constructor(notice: AgentLimitNotice) {
    super(notice.en);
    this.name = "AgentLimitReachedError";
    this.notice = notice;
  }
}

export type AgentLimitAudit = (event: {
  eventType: "agent.limit_refused";
  actorUserId: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

/** Every digital employee a person made on this install, hidden or not, and not deleted. */
export async function countOwnedAgents(database: Database): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(agentProfiles)
    .where(
      and(
        isNotNull(agentProfiles.ownerUserId),
        isNull(agentProfiles.deletedAt),
      ),
    );
  return Number(row?.value ?? 0);
}

export type AgentLimit = ReturnType<typeof createAgentLimit>;

export function createAgentLimit(dependencies: {
  activation: { current: () => Promise<ActivationView> };
  countAgents: () => Promise<number>;
  /** True while the signed trial roster is being set up. */
  isSeeding?: () => boolean;
  audit?: AgentLimitAudit;
}) {
  async function allowance(): Promise<
    AgentAllowance & { planId: string | null }
  > {
    const view = await dependencies.activation.current();
    const inUse = await dependencies.countAgents();
    const limit = view.agentLimit;
    const canAdd = limit === null || inUse < limit;
    return {
      limit,
      inUse,
      canAdd,
      agentsPerSeat: view.agentsPerSeat,
      seats: view.seats,
      planId: view.planId,
      notice:
        canAdd || limit === null
          ? null
          : agentLimitNotice({
              limit,
              inUse,
              agentsPerSeat: view.agentsPerSeat ?? 5,
              trial: view.state === "trial",
            }),
    };
  }

  return {
    async allowance(): Promise<AgentAllowance> {
      const { planId: _planId, ...rest } = await allowance();
      return rest;
    },

    /** Refuses, with the sentence and an audit row, when one more would pass the limit. */
    async refuseAdd(actor: AgentActor, path: AgentAddPath): Promise<void> {
      if (dependencies.isSeeding?.()) return;
      const state = await allowance();
      if (state.canAdd || !state.notice) return;
      await dependencies
        .audit?.({
          eventType: "agent.limit_refused",
          actorUserId: actor.id,
          payload: {
            path,
            limit: state.limit,
            inUse: state.inUse,
            agentsPerSeat: state.agentsPerSeat,
            seats: state.seats,
            planId: state.planId,
          },
        })
        .catch(() => undefined);
      throw new AgentLimitReachedError(state.notice);
    },
  };
}
