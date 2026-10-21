/**
 * What the lead of a team can do about its colleagues.
 *
 * The lead is the digital employee its owner made first, or chose (`agent_profiles.is_primary`). It
 * already knows who its colleagues are (`team.ts`). These are the hands to go with that: look at what
 * each one is doing, stop a routine that should not be running, ask a colleague for something, and
 * ask its owner for the changes that are not its to make alone.
 *
 * THE LINE BETWEEN WHAT IT MAY DO AND WHAT IT MAY ASK FOR is deliberate and drawn by how far a mistake
 * travels. Reading changes nothing. Switching a routine off or on is undone by switching it back, and
 * is recorded. Asking a colleague for work goes through the same desk, caps and audit as any hand-off.
 * Changing a routine, deleting one or rewriting a colleague's instructions is not undone by anything
 * the owner can see afterwards, so it becomes a request in their inbox and happens only if they say yes.
 *
 * OFFERED ONLY TO THE LEAD, FOR ITS OWN OWNER. A colleague is never offered these, and neither is the
 * lead when somebody else is using it (a shared employee), because every tool here acts on the data of
 * the person the run is for, and that person must be the one whose team it is.
 *
 * Refusals are sentences the model can say, never throws: the run has a person waiting on it.
 */
import { z } from "zod";
import { HANDED_OVER } from "../../../shared/handoff-markers";
import type { ApprovalStore } from "../approvals/store";
import { type AuditStore, recordAuditEvent } from "../audit";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import type { MemoryStore } from "../memories/store";
import type { RoutineStore, RoutineSummary } from "../routines/store";
import type { RunAssertion } from "./callback-token";
import type { HandoffDesk } from "./handoff";
import type { AgentProfileStore } from "./profile-store";
import type { AgentProfile } from "./profile-types";

export const TEAM_TOOL_PREFIX = "team_";

export type TeamToolDependencies = {
  profiles: Pick<AgentProfileStore, "list" | "get">;
  routines: Pick<RoutineStore, "listFor" | "setEnabled">;
  approvals: Pick<ApprovalStore, "request">;
  memories: Pick<MemoryStore, "list">;
  /** Absent when this deployment has switched hand-offs off. */
  handoff?: Pick<HandoffDesk, "send">;
  auditStore?: AuditStore;
};

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const nothing = z.object({});

const colleagueArgument = z
  .string()
  .describe("The colleague's name or id, as team_list shows it");

const reportParameters = z.object({ colleague: colleagueArgument });

const toggleParameters = z.object({
  routineId: z.string().describe("The routine's id, from team_report"),
  enabled: z
    .boolean()
    .describe("False switches it off, true switches it back on"),
});

const askParameters = z.object({
  colleague: colleagueArgument,
  task: z
    .string()
    .describe("What you are asking them to do, in a sentence or two"),
  constraints: z
    .string()
    .optional()
    .describe("Anything that bounds the work: a date range, a system, a rule"),
  expecting: z
    .string()
    .optional()
    .describe("What a good answer looks like when it comes back"),
});

const requestParameters = z.object({
  kind: z
    .enum([
      "update_routine",
      "delete_routine",
      "replace_instructions",
      "update_memory",
      "delete_memory",
    ])
    .describe(
      "update_routine changes a colleague's routine, delete_routine removes one, replace_instructions rewrites a colleague's full instructions, update_memory rewords one of its memories, delete_memory removes one",
    ),
  reason: z
    .string()
    .describe("Why, in a sentence. Your owner reads it before deciding"),
  colleague: colleagueArgument.optional(),
  routineId: z
    .string()
    .optional()
    .describe("For the routine kinds: the routine's id, from team_report"),
  cron: z
    .string()
    .optional()
    .describe("update_routine: a new five-field schedule"),
  timezone: z
    .string()
    .optional()
    .describe("update_routine: a new IANA timezone"),
  instruction: z
    .string()
    .optional()
    .describe("update_routine: a new instruction for each firing"),
  memoryId: z
    .string()
    .optional()
    .describe("For the memory kinds: the memory's id, from team_report"),
  content: z
    .string()
    .optional()
    .describe("update_memory: the new wording, one short sentence"),
  newInstructions: z
    .string()
    .optional()
    .describe(
      "replace_instructions: the full new instructions, up to 8000 characters",
    ),
});

type Context = {
  deps: TeamToolDependencies;
  botId: string;
  actorId: string;
  /** The run this call belongs to. Only the call-back route knows it, and only asking needs it. */
  run?: RunAssertion;
};

const owner = (actorId: string) => ({ id: actorId, role: "user" as const });

/** The owner's other digital employees. Never anybody else's, whatever the actor could see. */
async function colleaguesOf(context: Context): Promise<AgentProfile[]> {
  const roster = await context.deps.profiles.list(owner(context.actorId));
  return roster.filter(
    (profile) =>
      profile.ownerUserId === context.actorId &&
      profile.id !== context.botId &&
      !profile.hidden &&
      profile.deletedAt === null,
  );
}

type Resolved =
  | { ok: true; colleague: AgentProfile }
  | { ok: false; refusal: string };

async function resolveColleague(
  context: Context,
  given: string | undefined,
): Promise<Resolved> {
  const wanted = (given ?? "").trim().toLowerCase();
  if (!wanted) {
    return {
      ok: false,
      refusal: `${REFUSAL_MARKER} Say which colleague, by the name or id team_list shows.`,
    };
  }
  const team = await colleaguesOf(context);
  const byId = team.find((profile) => profile.id.toLowerCase() === wanted);
  if (byId) return { ok: true, colleague: byId };
  const byName = team.filter(
    (profile) => profile.name.toLowerCase() === wanted,
  );
  if (byName.length === 1 && byName[0]) {
    return { ok: true, colleague: byName[0] };
  }
  if (byName.length > 1) {
    return {
      ok: false,
      refusal: `${REFUSAL_MARKER} More than one colleague is called "${clip(given ?? "", 60)}": ${byName
        .map((profile) => profile.id)
        .join(", ")}. Use the id of the one you mean.`,
    };
  }
  return {
    ok: false,
    refusal: `${REFUSAL_MARKER} There is no colleague called "${clip(given ?? "", 60)}" on your team.`,
  };
}

function routineLine(routine: RoutineSummary): string {
  const last = routine.lastRun
    ? routine.lastRun.finishedAt
      ? `last ran ${routine.lastRun.finishedAt.toISOString().slice(0, 16).replace("T", " ")} UTC${routine.lastRun.status ? ` (${routine.lastRun.status})` : ""}`
      : "running now"
    : "never run";
  return `- "${clip(oneLine(routine.instruction), 120)}": ${routine.schedule} (${routine.timezone}), ${routine.enabled ? "on" : "switched off"}, ${last}. id: ${routine.id}`;
}

async function audit(
  context: Context,
  action: string,
  extra: Record<string, unknown>,
) {
  if (!context.deps.auditStore) return;
  await recordAuditEvent(context.deps.auditStore, {
    eventType: "team.action",
    targetType: "agent",
    targetId: context.botId,
    actorUserId: context.actorId,
    payload: { bot: context.botId, action, ...extra },
  });
}

/**
 * The tools, built for one run of one digital employee. Empty for anyone who is not a lead working
 * for the person whose team it is.
 */
export async function teamTools(context: Context): Promise<GrantedTool[]> {
  const me = await context.deps.profiles.get(
    owner(context.actorId),
    context.botId,
  );
  if (!me || me.ownerUserId !== context.actorId) return [];
  // A team of one has nobody to look after or ask, so only the lead is offered the roster: asked
  // whether it can work with its team it then looks, finds nobody, and says so, instead of reporting
  // that it has no tool for it. The rest of the tools would only be noise in its prompt.
  const alone = (await colleaguesOf(context)).length === 0;
  if (alone && !me.primary) return [];

  const everyone: GrantedTool[] = [
    {
      name: "team_list",
      ref: "team/list",
      description:
        "List your colleagues: their names, ids, titles and what each is for. Use it before asking one for anything.",
      parameters: nothing,
      execute: async () => {
        const team = await colleaguesOf(context);
        if (team.length === 0) {
          return "You have no colleagues yet. Your owner can add more digital employees.";
        }
        return team
          .map(
            (profile) =>
              `- ${profile.name} (${profile.title}), id: ${profile.id}. ${clip(oneLine(profile.roleDescription), 200)}`,
          )
          .join("\n");
      },
    },

    {
      name: "team_report",
      ref: "team/report",
      description:
        "See what one colleague does on a schedule and how it last went: each routine, when it runs, whether it is on, and how its last run ended. Read-only.",
      parameters: reportParameters,
      execute: async (args) => {
        const parsed = reportParameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} Say which colleague.`;
        const found = await resolveColleague(context, parsed.data.colleague);
        if (!found.ok) return found.refusal;
        const all = await context.deps.routines.listFor(context.actorId);
        const mine = all.filter(
          (routine) => routine.agentId === found.colleague.id,
        );
        const kept = await context.deps.memories.list(
          context.actorId,
          found.colleague.id,
        );
        await audit(context, "report", { target: found.colleague.id });
        const failing = mine.filter(
          (r) => r.lastRun?.status === "failed",
        ).length;
        return [
          mine.length === 0
            ? `${found.colleague.name} has nothing scheduled.`
            : `${found.colleague.name} (${found.colleague.title}) has ${mine.length} ${mine.length === 1 ? "routine" : "routines"}${failing ? `, ${failing} failing` : ""}:`,
          ...mine.map(routineLine),
          kept.length === 0
            ? `${found.colleague.name} keeps nothing in mind.`
            : `${found.colleague.name} keeps ${kept.length} ${kept.length === 1 ? "thing" : "things"} in mind:`,
          ...kept.map(
            (memory) =>
              `- "${clip(oneLine(memory.content), 160)}". id: ${memory.id}`,
          ),
        ].join("\n");
      },
    },

    {
      name: "team_pause_routine",
      ref: "team/pause_routine",
      description:
        "Switch one of your colleague's routines off, or back on. Use it for a routine that should not be running right now. It changes nothing else and is undone by switching it back.",
      parameters: toggleParameters,
      execute: async (args) => {
        const parsed = toggleParameters.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} Give the routine's id and whether it should be on.`;
        }
        const all = await context.deps.routines.listFor(context.actorId);
        const routine = all.find(
          (candidate) => candidate.id === parsed.data.routineId,
        );
        const team = await colleaguesOf(context);
        const colleague = team.find(
          (profile) => profile.id === routine?.agentId,
        );
        // A routine that is yours, or nobody's, is not a colleague's to switch from here.
        if (!routine || !colleague) {
          return `${REFUSAL_MARKER} There is no routine of a colleague's with that id.`;
        }
        await context.deps.routines.setEnabled(
          context.actorId,
          routine.id,
          parsed.data.enabled,
        );
        await audit(
          context,
          parsed.data.enabled ? "resume_routine" : "pause_routine",
          {
            target: colleague.id,
            routine: routine.id,
          },
        );
        return parsed.data.enabled
          ? `${colleague.name}'s routine is switched back on.`
          : `${colleague.name}'s routine is switched off. It will not run until it is switched back on.`;
      },
    },

    {
      name: "team_request_change",
      ref: "team/request_change",
      description:
        "Ask your owner to change a colleague's routine, delete one, or rewrite a colleague's instructions. Nothing changes until your owner approves it in their Requests screen, so tell them you have asked and why, and do not say it is done.",
      parameters: requestParameters,
      execute: async (args) => {
        const parsed = requestParameters.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} Say what kind of change, why, and which routine or colleague.`;
        }
        const input = parsed.data;
        const reason = clip(oneLine(input.reason), 200);
        const team = await colleaguesOf(context);

        try {
          if (input.kind === "replace_instructions") {
            const found = await resolveColleague(context, input.colleague);
            if (!found.ok) return found.refusal;
            const text = (input.newInstructions ?? "").trim();
            if (!text) {
              return `${REFUSAL_MARKER} Give the new instructions in full.`;
            }
            if (text.length > 8000) {
              return `${REFUSAL_MARKER} Instructions can be 8000 characters at most.`;
            }
            await context.deps.approvals.request({
              ownerUserId: context.actorId,
              requestedByAgentId: context.botId,
              kind: "instructions.update",
              targetAgentId: found.colleague.id,
              summary: `Replace ${found.colleague.name}'s instructions with: "${clip(oneLine(text), 260)}" Why: ${reason}`,
              payload: { persona: text },
            });
            await audit(context, "request_change", {
              target: found.colleague.id,
              kind: input.kind,
            });
            return `Asked your owner. ${found.colleague.name}'s instructions are unchanged until they approve it in Requests.`;
          }

          if (
            input.kind === "update_memory" ||
            input.kind === "delete_memory"
          ) {
            const found = await resolveColleague(context, input.colleague);
            if (!found.ok) return found.refusal;
            const kept = await context.deps.memories.list(
              context.actorId,
              found.colleague.id,
            );
            const memory = kept.find(
              (candidate) => candidate.id === input.memoryId,
            );
            if (!memory) {
              return `${REFUSAL_MARKER} ${found.colleague.name} has no memory with that id. Use team_report to find it.`;
            }
            const was = `"${clip(oneLine(memory.content), 120)}"`;
            if (input.kind === "delete_memory") {
              await context.deps.approvals.request({
                ownerUserId: context.actorId,
                requestedByAgentId: context.botId,
                kind: "memory.delete",
                targetAgentId: found.colleague.id,
                targetId: memory.id,
                summary: `Delete this memory of ${found.colleague.name}'s: ${was}. Why: ${reason}`,
                payload: { memoryId: memory.id },
              });
            } else {
              const content = (input.content ?? "").trim();
              if (!content) {
                return `${REFUSAL_MARKER} Give the new wording, one short sentence.`;
              }
              await context.deps.approvals.request({
                ownerUserId: context.actorId,
                requestedByAgentId: context.botId,
                kind: "memory.update",
                targetAgentId: found.colleague.id,
                targetId: memory.id,
                summary: `Change this memory of ${found.colleague.name}'s from ${was} to "${clip(oneLine(content), 160)}". Why: ${reason}`,
                payload: { memoryId: memory.id, content },
              });
            }
            await audit(context, "request_change", {
              target: found.colleague.id,
              memory: memory.id,
              kind: input.kind,
            });
            return `Asked your owner. ${found.colleague.name}'s memory stays as it is until they approve it in Requests.`;
          }

          const all = await context.deps.routines.listFor(context.actorId);
          const routine = all.find(
            (candidate) => candidate.id === input.routineId,
          );
          const colleague = team.find(
            (profile) => profile.id === routine?.agentId,
          );
          if (!routine || !colleague) {
            return `${REFUSAL_MARKER} There is no routine of a colleague's with that id. Use team_report to find it.`;
          }
          const label = `${colleague.name}'s routine "${clip(oneLine(routine.instruction), 80)}" (${routine.schedule})`;

          if (input.kind === "delete_routine") {
            await context.deps.approvals.request({
              ownerUserId: context.actorId,
              requestedByAgentId: context.botId,
              kind: "routine.delete",
              targetAgentId: colleague.id,
              targetId: routine.id,
              summary: `Delete ${label}. It will not run again. Why: ${reason}`,
              payload: { routineId: routine.id },
            });
          } else {
            const patch: Record<string, string> = {};
            if (input.cron) patch.cron = input.cron;
            if (input.timezone) patch.timezone = input.timezone;
            if (input.instruction) patch.instruction = input.instruction;
            if (Object.keys(patch).length === 0) {
              return `${REFUSAL_MARKER} Say what should change: a schedule, a timezone or an instruction.`;
            }
            const changes = Object.entries(patch)
              .map(
                ([key, value]) =>
                  `${key === "cron" ? "schedule" : key} to "${clip(oneLine(value), 100)}"`,
              )
              .join(", ");
            await context.deps.approvals.request({
              ownerUserId: context.actorId,
              requestedByAgentId: context.botId,
              kind: "routine.update",
              targetAgentId: colleague.id,
              targetId: routine.id,
              summary: `Change ${label}: ${changes}. Why: ${reason}`,
              payload: { routineId: routine.id, patch },
            });
          }
          await audit(context, "request_change", {
            target: colleague.id,
            routine: routine.id,
            kind: input.kind,
          });
          return `Asked your owner. Nothing has changed: ${colleague.name}'s routine stays as it is until they approve it in Requests.`;
        } catch (error) {
          // The store words its refusals for the model (too many waiting, nothing to change).
          return `${REFUSAL_MARKER} ${error instanceof Error ? error.message : "The request could not be made."}`;
        }
      },
    },

    {
      name: "team_ask",
      ref: "team/ask",
      description:
        "Ask one colleague to do a piece of work and answer for itself. It replies in this conversation when it is done, so tell the person who you asked and what for, and do not answer on its behalf.",
      parameters: askParameters,
      execute: async (args) => {
        const parsed = askParameters.safeParse(args);
        if (!parsed.success) {
          return `${REFUSAL_MARKER} Say which colleague and what you are asking.`;
        }
        if (!context.deps.handoff) {
          return `${REFUSAL_MARKER} This deployment does not let digital employees ask each other for work.`;
        }
        if (!context.run) {
          return `${REFUSAL_MARKER} Asking a colleague works from a conversation with the person. Tell them what you would ask and who, and they can ask for it.`;
        }
        const found = await resolveColleague(context, parsed.data.colleague);
        if (!found.ok) return found.refusal;
        const outcome = await context.deps.handoff.send({
          from: context.run,
          // The id, so a name shared with another person's employee can never decide who is asked.
          target: found.colleague.id,
          envelope: {
            task: parsed.data.task,
            ...(parsed.data.constraints
              ? { constraints: parsed.data.constraints }
              : {}),
            ...(parsed.data.expecting
              ? { expecting: parsed.data.expecting }
              : {}),
          },
        });
        return outcome.ok
          ? `${HANDED_OVER}${outcome.toName}. Its answer will be relayed back into this conversation when it finishes, so tell the person you have asked it and what for, and do not answer on its behalf.`
          : outcome.refusal;
      },
    },
  ];

  // Everybody on a team can see who is on it and ask a colleague; looking after the colleagues' work
  // is the lead's alone.
  const LEAD_ONLY = new Set([
    "team_report",
    "team_pause_routine",
    "team_request_change",
  ]);
  if (alone) return everyone.filter((tool) => tool.name === "team_list");
  return me.primary
    ? everyone
    : everyone.filter((tool) => !LEAD_ONLY.has(tool.name));
}
