/**
 * Setting up a trial's roster for the person on this install (#109).
 *
 * Each roster entry becomes a private digital employee of that person, with the profile's name,
 * title, role description and standing instruction. An entry `basedOn` an official role also gets
 * that role's skills, as hiring it would. The lead is the entry marked so, or the first.
 *
 * Under the block, the deployment's own example employees are hidden for the person, so the team
 * they see is the roster and nothing else; bringing one back is refused by the guard.
 */

import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { ROLES } from "../marketplace/official-roles";
import type { TrialService } from "./service";

export type TrialSkills = {
  install: (input: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
    origin?: string;
    ownerUserId: string | null;
    by: string;
  }) => Promise<{ id: string }>;
  grant: (
    kind: "skill",
    ref: string,
    agentId: string,
    by: string,
  ) => Promise<unknown>;
};

export async function seedTrialRoster(
  actor: AgentActor,
  dependencies: {
    trial: Pick<TrialService, "seed" | "roster" | "rosterAgents" | "current">;
    profiles: AgentProfileStore;
    skills?: TrialSkills;
  },
): Promise<number> {
  const { trial, profiles, skills } = dependencies;
  const roster = await trial.roster();
  const leadKey = (roster.find((entry) => entry.lead) ?? roster[0])?.key;
  const made = await trial.seed(async (entry) => {
    const profile = await profiles.create(actor, {
      name: entry.name,
      title: entry.title,
      roleDescription: entry.roleDescription,
      visibility: "private",
      systemPrompt: entry.instructions,
      persona: entry.instructions,
    });
    const role = entry.basedOn
      ? ROLES.find((spec) => spec.slug === entry.basedOn)
      : undefined;
    if (role && skills) {
      for (const skill of role.skills) {
        try {
          const saved = await skills.install({
            slug: skill.slug,
            title: skill.title,
            summary: skill.summary,
            instructions: skill.instructions,
            origin: `trial:${entry.key}`,
            ownerUserId: actor.id,
            by: actor.id,
          });
          await skills.grant("skill", saved.id, profile.id, actor.id);
        } catch (error) {
          console.error(
            `Could not add the skill /${skill.slug} for the trial employee ${entry.key}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    if (entry.key === leadKey) await profiles.setPrimary(actor, profile.id);
    return { agentId: profile.id };
  });
  if (made > 0 && (await trial.current())?.createBlocked) {
    const onRoster = new Set(
      (await trial.rosterAgents()).map((row) => row.agentId),
    );
    for (const employee of await profiles.list(actor)) {
      if (employee.ownerUserId === null && !onRoster.has(employee.id)) {
        await profiles.setHidden(actor, employee.id, true);
      }
    }
  }
  return made;
}
