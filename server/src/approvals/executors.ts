import type { AgentProfileStore } from "../agents/profile-store";
import type { RoutinePatch, RoutineStore } from "../routines/store";
import type { ApprovalExecutor } from "./store";

/**
 * What approving each kind of request actually does.
 *
 * Each executor re-checks, at the moment of approval, that the thing still belongs to the person
 * approving it: a request can wait a week, and the routine it names may have been deleted or the
 * digital employee handed to somebody else since. The stores they call are owner-scoped, so a thing
 * that is no longer theirs reads as missing, and the approval fails with a sentence instead of
 * touching it.
 *
 * The payload was written by a model, so it is read as untrusted here even though the same code wrote
 * it a moment ago: only the fields each kind knows are taken, and only in the shapes they allow.
 */

export const APPROVAL_KINDS = [
  "routine.update",
  "routine.delete",
  "instructions.update",
] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from the request.`);
  }
  return value;
};

function routinePatchFrom(value: unknown): RoutinePatch {
  const source = (typeof value === "object" && value ? value : {}) as Record<
    string,
    unknown
  >;
  const patch: RoutinePatch = {};
  if (typeof source.instruction === "string")
    patch.instruction = source.instruction;
  if (typeof source.cron === "string") patch.cron = source.cron;
  if (typeof source.timezone === "string") patch.timezone = source.timezone;
  if (typeof source.enabled === "boolean") patch.enabled = source.enabled;
  if (Object.keys(patch).length === 0) {
    throw new Error("The request does not change anything about the routine.");
  }
  return patch;
}

export function approvalExecutors(dependencies: {
  routines: Pick<RoutineStore, "update" | "remove">;
  profiles: Pick<AgentProfileStore, "get" | "update">;
}): Record<ApprovalKind, ApprovalExecutor> {
  const { routines, profiles } = dependencies;
  return {
    "routine.update": async (approval) => {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      await routines.update(
        approval.ownerUserId,
        text(payload.routineId, "The routine"),
        routinePatchFrom(payload.patch),
      );
      return "The routine was changed.";
    },

    "routine.delete": async (approval) => {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      await routines.remove(
        approval.ownerUserId,
        text(payload.routineId, "The routine"),
      );
      return "The routine was deleted. It will not run again.";
    },

    "instructions.update": async (approval) => {
      const payload = (approval.payload ?? {}) as Record<string, unknown>;
      const targetId = text(approval.targetAgentId, "The digital employee");
      const persona =
        typeof payload.persona === "string" && payload.persona.trim()
          ? payload.persona.trim().slice(0, 8000)
          : null;
      const actor = { id: approval.ownerUserId, role: "user" as const };
      const current = await profiles.get(actor, targetId);
      if (!current || current.ownerUserId !== approval.ownerUserId) {
        throw new Error("That digital employee is no longer yours to change.");
      }
      await profiles.update(actor, targetId, {
        name: current.name,
        title: current.title,
        roleDescription: current.roleDescription,
        visibility: current.visibility,
        persona,
      });
      return persona
        ? "The instructions were replaced."
        : "The instructions were cleared; the role is the whole instruction again.";
    },
  };
}
