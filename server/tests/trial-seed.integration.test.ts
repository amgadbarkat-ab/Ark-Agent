/**
 * The roster set up on the real stores, under the block (#109): exactly the profile's employees, the
 * lead it names, nothing else made afterwards, and a routine still runs for a roster employee.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  routines,
  trialCodes,
  trialRoster,
  trialState,
  users,
} from "../src/db/schema";
import { createRoutineStore } from "../src/routines/store";
import { guardProfiles } from "../src/trial/guard";
import { seedTrialRoster } from "../src/trial/seed";
import {
  createTrialService,
  TrialCreateBlockedError,
} from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const key = generateKeyPairSync("ed25519");
const userId = `trial-seed-${randomUUID()}`;
const actor: AgentActor = { id: userId, role: "admin" };
const madeAgents: string[] = [];
const madeChannels: string[] = [];

afterAll(async () => {
  await database.delete(routines).where(eq(routines.ownerUserId, userId));
  for (const id of madeChannels) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, id));
    await database.delete(channels).where(eq(channels.id, id));
  }
  const seeded = (await database.select().from(trialRoster)).map(
    (row) => row.agentId,
  );
  const all = [...madeAgents, ...seeded];
  if (all.length > 0) {
    await database
      .delete(agentPreferences)
      .where(inArray(agentPreferences.agentId, all));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, all));
    await database.delete(agents).where(inArray(agents.id, all));
  }
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(trialCodes);
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

function file() {
  const profile = readProfile({
    v: 1,
    customer: { id: "eurodiagnosi", name: "Eurodiagnosi" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2099-12-16T00:00:00Z",
    plan: "team",
    createBlocked: true,
    mailBlockAmka: true,
    roster: [
      {
        key: "front-desk",
        name: "Υποδοχή",
        title: "Front Desk",
        roleDescription: "Answers enquiries. No medical advice.",
        instructions: "You are the front desk. Never give medical advice.",
        basedOn: "front-desk",
        mail: { folders: ["INBOX/Front"], from: "info@eurodiagnosi.example" },
      },
      {
        key: "qa-auditing",
        name: "QA & Auditing",
        title: "Quality",
        roleDescription: "Checks the team's drafts.",
        instructions: "Check drafts for the house rules.",
        lead: true,
      },
    ],
  });
  const encoded = encodeBase64Url(JSON.stringify(profile));
  return JSON.stringify({
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(key.privateKey, encoded),
  });
}

describe("setting up a trial roster on the real stores (#109)", () => {
  test("exactly the roster, the named lead, no more after, and a routine still works", async () => {
    await database.delete(trialState);
    await database.delete(trialRoster);
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: "Trial" });
    const trial = createTrialService(database, {
      keys: [key.publicKey],
      version: "0.1.37",
    });
    const profiles = guardProfiles(
      createAgentProfileStore(database, undefined),
      trial,
    );
    // Made before the trial, like a package example the person already sees.
    const before = await profiles.create(actor, {
      name: "Before",
      title: "x",
      roleDescription: "x",
      visibility: "private",
      systemPrompt: "x",
    });
    madeAgents.push(before.id);

    await trial.importProfile(file());
    const installed: string[] = [];
    const mailed: string[] = [];
    const made = await seedTrialRoster(actor, {
      grantMailbox: async (agentId) => {
        mailed.push(agentId);
      },
      trial,
      profiles,
      skills: {
        install: async (input) => {
          installed.push(input.slug);
          return { id: `skill-${input.slug}` };
        },
        grant: async () => undefined,
      },
    });
    expect(made).toBe(2);
    expect(await seedTrialRoster(actor, { trial, profiles })).toBe(0);
    expect(installed).toContain("front-desk-take-message");

    const team = await profiles.list(actor);
    const names = team.map((p) => p.name).sort();
    expect(names).toEqual(["Before", "QA & Auditing", "Υποδοχή"]);
    expect(team.find((p) => p.primary)?.name).toBe("QA & Auditing");

    await expect(
      profiles.create(actor, {
        name: "Extra",
        title: "x",
        roleDescription: "x",
        visibility: "private",
        systemPrompt: "x",
      }),
    ).rejects.toThrow(TrialCreateBlockedError);
    await expect(profiles.duplicate(actor, before.id)).rejects.toThrow(
      TrialCreateBlockedError,
    );

    const frontDesk = team.find((p) => p.name === "Υποδοχή");
    if (!frontDesk) throw new Error("no front desk");
    const qa = team.find((p) => p.name === "QA & Auditing");

    // Only the mail employee gets the mailbox, with its folder and From address; AMKA for all.
    expect(mailed).toEqual([frontDesk.id]);
    expect(await trial.mailPolicyFor(frontDesk.id)).toEqual({
      folders: ["INBOX/Front"],
      from: "info@eurodiagnosi.example",
      blockAmka: true,
    });
    expect(await trial.mailPolicyFor(qa?.id)).toEqual({ blockAmka: true });
    const channel = await createChannelStore(
      database,
      profiles,
      createThreadIdentity("trial-test"),
    ).create(actor, [frontDesk.id]);
    madeChannels.push(channel.id);
    const routine = await createRoutineStore(database).create({
      ownerUserId: userId,
      agentId: frontDesk.id,
      channelId: channel.id,
      instruction: "Write the morning briefing for the team.",
      cron: "0 7 * * *",
    });
    expect(routine.enabled).toBe(true);
  });
});
