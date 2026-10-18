import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore, TeamTooSmallError } from "../src/channels/routes";
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
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profiles,
  createThreadIdentity("test-deployment"),
);

const prefix = `team-channel-${randomUUID()}`;
const userIds: string[] = [];
const agentIds: string[] = [];
const channelIds: string[] = [];

afterEach(async () => {
  for (const id of channelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, id));
    await database.delete(channels).where(eq(channels.id, id));
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

async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Team Channel Test" });
  userIds.push(id);
  return { id, role: "user" };
}

async function employee(owner: AgentActor, name: string) {
  const made = await profiles.create(owner, {
    name,
    title: "Teammate",
    roleDescription: `${name} works.`,
    visibility: "private",
  });
  agentIds.push(made.id);
  return made;
}

describe("the team channel", () => {
  test("needs somebody besides the lead", async () => {
    const owner = await person();
    await employee(owner, "Ana");
    await expect(store.team(owner)).rejects.toBeInstanceOf(TeamTooSmallError);
  });

  test("holds the whole team with the lead first, whatever the ids sort like", async () => {
    const owner = await person();
    const first = await employee(owner, "Ana");
    const second = await employee(owner, "Ben");
    const third = await employee(owner, "Cy");
    // Make the lead the one whose id would sort last, to prove order comes from leading.
    const last = [first, second, third].sort((a, b) =>
      b.id.localeCompare(a.id),
    )[0];
    if (!last) throw new Error("no employees");
    await profiles.setPrimary(owner, last.id);

    const channel = await store.team(owner);
    channelIds.push(channel.id);
    expect(channel.name).toBe("Your team");
    expect(channel.agentIds[0]).toBe(last.id);
    expect([...channel.agentIds].sort()).toEqual(
      [first.id, second.id, third.id].sort(),
    );
    expect(channel.active).toBe(true);
  });

  test("opening it again finds the same channel, not a second one", async () => {
    const owner = await person();
    await employee(owner, "Ana");
    await employee(owner, "Ben");
    const one = await store.team(owner);
    channelIds.push(one.id);
    const again = await store.team(owner);
    expect(again.id).toBe(one.id);
    expect(again.threadId).toBe(one.threadId);
  });

  test("two opens at once still make one", async () => {
    const owner = await person();
    await employee(owner, "Ana");
    await employee(owner, "Ben");
    const [a, b] = await Promise.all([store.team(owner), store.team(owner)]);
    if (a) channelIds.push(a.id);
    expect(a?.id).toBe(b?.id);
  });

  test("a colleague added later joins it, and one deleted leaves it", async () => {
    const owner = await person();
    const ana = await employee(owner, "Ana");
    const ben = await employee(owner, "Ben");
    const channel = await store.team(owner);
    channelIds.push(channel.id);

    const cy = await employee(owner, "Cy");
    expect((await store.team(owner)).agentIds).toContain(cy.id);

    await profiles.softDelete(owner, ben.id);
    const after = await store.team(owner);
    expect(after.agentIds).not.toContain(ben.id);
    expect(after.agentIds).toContain(ana.id);
    expect(after.active).toBe(true);
    expect(after.id).toBe(channel.id);
  });

  test("it is not a direct channel with anybody, and shared employees are not on it", async () => {
    const owner = await person();
    const stranger = await person();
    const ana = await employee(owner, "Ana");
    await employee(owner, "Ben");
    const shared = await profiles.create(stranger, {
      name: "Shared",
      title: "Teammate",
      roleDescription: "Shared works.",
      visibility: "public",
    });
    agentIds.push(shared.id);

    const team = await store.team(owner);
    channelIds.push(team.id);
    expect(team.agentIds).not.toContain(shared.id);
    // Asking for a one-to-one channel with Ana gives a different, private one.
    const direct = await store.direct(owner, ana.id);
    channelIds.push(direct.id);
    expect(direct.id).not.toBe(team.id);
    expect(direct.agentIds).toEqual([ana.id]);
  });
});
