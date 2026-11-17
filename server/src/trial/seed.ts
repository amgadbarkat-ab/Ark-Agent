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
    /** Gives one employee the customer's mailbox (#109). Idempotent. */
    grantMailbox?: (agentId: string) => Promise<void>;
    /** Gives one employee a built-in tool set: the price list or video editing (#109). Idempotent. */
    grantBuiltin?: (
      agentId: string,
      key:
        | "price-list"
        | "video"
        | "skroutz"
        | "woocommerce"
        | "boxnow"
        | "elta"
        | "business-files"
        | "price-watch",
    ) => Promise<void>;
  },
): Promise<number> {
  const { trial, profiles, skills, grantMailbox, grantBuiltin } = dependencies;
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
  /*
   * The mail employees get the mailbox, every time this runs, so an install that was set up before
   * mail existed (v0.1.37) gets it on its first start of v0.1.38. Granting twice changes nothing.
   */
  if (grantMailbox || grantBuiltin) {
    const seeded = new Map(
      (await trial.rosterAgents()).map((row) => [row.key, row.agentId]),
    );
    for (const entry of roster) {
      const agentId = seeded.get(entry.key);
      if (!agentId) continue;
      if (entry.mail && grantMailbox) await grantMailbox(agentId);
      if (entry.priceList && grantBuiltin)
        await grantBuiltin(agentId, "price-list");
      if (entry.video && grantBuiltin) await grantBuiltin(agentId, "video");
      for (const connector of entry.connectors ?? []) {
        if (grantBuiltin) await grantBuiltin(agentId, connector);
      }
    }
  }
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

/**
 * Writes a newer signed profile's role description and standing instruction onto the roster's
 * employees already set up (#116). They are read-only on this computer, so this is the one way a
 * change BlackArk accepted (from "Propose a change") reaches them: the new profile is imported, and
 * each employee whose text differs gets the profile's. Names, titles and pictures are left as the
 * customer set them; an employee somebody deleted stays deleted. Returns how many changed.
 */
export async function applyProfileInstructions(
  actor: AgentActor,
  dependencies: {
    trial: Pick<TrialService, "roster" | "rosterAgents" | "asProfile">;
    profiles: AgentProfileStore;
  },
): Promise<number> {
  const { trial, profiles } = dependencies;
  const roster = new Map(
    (await trial.roster()).map((entry) => [entry.key, entry]),
  );
  let changed = 0;
  for (const { key, agentId } of await trial.rosterAgents()) {
    const entry = roster.get(key);
    if (!entry) continue;
    const current = await profiles.get(actor, agentId);
    if (!current || current.deletedAt) continue;
    if (
      current.roleDescription === entry.roleDescription &&
      (current.persona ?? null) === entry.instructions
    ) {
      continue;
    }
    await trial.asProfile(() =>
      profiles.update(actor, agentId, {
        name: current.name,
        title: current.title,
        roleDescription: entry.roleDescription,
        visibility: current.visibility,
        persona: entry.instructions,
      }),
    );
    changed += 1;
  }
  return changed;
}
