import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createTeamReach } from "../src/agents/lead-reach";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const company = createAccountStore(database, { billingMode: "internal" });
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
  undefined,
  company,
);
const prefix = `lead-reach-${randomUUID()}`;
const userIds: string[] = [];
const agentIds: string[] = [];

afterEach(async () => {
  for (const userId of userIds) {
    const made = await database
      .select({ id: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.userId, userId));
    for (const row of made) {
      await database
        .delete(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.channelId, row.id));
      await database.delete(channels).where(eq(channels.id, row.id));
    }
  }
  for (const id of agentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const id of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});
afterAll(async () => {
  await database.$client.close();
});

async function person() {
  const id = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Approvals Test" });
  userIds.push(id);
  await company.ensureTenant(id);
  return { id, role: "user" as const };
}

async function employee(owner: { id: string; role: "user" }, name: string) {
  const made = await profiles.create(owner, {
    name,
    title: "Teammate",
    roleDescription: `${name} works.`,
    visibility: "private",
  });
  agentIds.push(made.id);
  return made;
}

const leadMayAddress = createTeamReach(database);
const channelStore = createChannelStore(
  database,
  profiles,
  createThreadIdentity("test-deployment"),
);

describe("who the lead may ask without a grant", () => {
  test("the lead may ask the other employees of the same person", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const other = await employee(owner, "Ben");
    expect(lead.primary).toBe(true);
    expect(await leadMayAddress(lead.id, other.id)).toBe(true);
  });

  test("a colleague that does not lead may not, in either direction", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const other = await employee(owner, "Ben");
    expect(await leadMayAddress(other.id, lead.id)).toBe(false);
  });

  test("not somebody else's employee, even a public one", async () => {
    const owner = await person();
    const stranger = await person();
    const lead = await employee(owner, "Ana");
    const theirs = await profiles.create(stranger, {
      name: "Theirs",
      title: "Teammate",
      roleDescription: "Theirs works.",
      visibility: "public",
    });
    agentIds.push(theirs.id);
    expect(await leadMayAddress(lead.id, theirs.id)).toBe(false);
  });

  test("not a deleted colleague, and not once another has been made the lead", async () => {
    const owner = await person();
    const lead = await employee(owner, "Ana");
    const other = await employee(owner, "Ben");
    await profiles.setPrimary(owner, other.id);
    expect(await leadMayAddress(lead.id, other.id)).toBe(false);
    expect(await leadMayAddress(other.id, lead.id)).toBe(true);
    await profiles.softDelete(owner, lead.id);
    expect(await leadMayAddress(other.id, lead.id)).toBe(false);
  });

  test("not itself being unknown", async () => {
    expect(await leadMayAddress("agent_nope", "agent_nada")).toBe(false);
  });
});

describe("who may ask whom in a room", () => {
  test("two colleagues may ask each other in the team channel, and not outside it", async () => {
    const owner = await person();
    await employee(owner, "Ana");
    const ben = await employee(owner, "Ben");
    const cy = await employee(owner, "Cy");
    const team = await channelStore.team(owner);

    // Neither of them leads, so without the room the answer is no.
    expect(await leadMayAddress(ben.id, cy.id)).toBe(false);
    expect(await leadMayAddress(ben.id, cy.id, "some-other-thread")).toBe(
      false,
    );
    expect(await leadMayAddress(ben.id, cy.id, team.threadId)).toBe(true);
    expect(await leadMayAddress(cy.id, ben.id, team.threadId)).toBe(true);
  });

  test("a colleague who is not in the room may not be asked from it", async () => {
    const owner = await person();
    await employee(owner, "Ana");
    const ben = await employee(owner, "Ben");
    await employee(owner, "Cy");
    const team = await channelStore.team(owner);
    // Made after the room, and not yet in it until the channel is opened again.
    const dee = await employee(owner, "Dee");
    expect(await leadMayAddress(ben.id, dee.id, team.threadId)).toBe(false);
    await channelStore.team(owner);
    expect(await leadMayAddress(ben.id, dee.id, team.threadId)).toBe(true);
  });

  test("never across two people, whatever room they share", async () => {
    const owner = await person();
    const stranger = await person();
    await employee(owner, "Ana");
    const ben = await employee(owner, "Ben");
    const theirs = await profiles.create(stranger, {
      name: "Theirs",
      title: "Teammate",
      roleDescription: "Theirs works.",
      visibility: "public",
    });
    agentIds.push(theirs.id);
    const team = await channelStore.team(owner);
    expect(await leadMayAddress(ben.id, theirs.id, team.threadId)).toBe(false);
  });
});
