import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, skills, users } from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Whose skill is whose, and which Bots a person may put one on.
 *
 * Any user may write a skill because a skill is an instruction rather than a capability: it can only
 * ask for tools the Bot already holds, and every one of those calls is still decided and audited.
 * The security property is scoping: a skill is visible to its author and reaches only Bots that
 * author owns.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const suite = randomUUID().slice(0, 8);
const alice = `user_alice_${suite}`;
const bob = `user_bob_${suite}`;
const aliceBot = `agent_alice_${suite}`;
const sharedBot = `agent_shared_${suite}`;
const aliceSkill = `alice-skill-${suite}`;
const bobSkill = `bob-skill-${suite}`;
const deploymentSkill = `deployment-skill-${suite}`;
let aliceSkillId = "";
let bobSkillId = "";
let deploymentSkillId = "";

beforeAll(async () => {
  for (const [id, email] of [
    [alice, `alice-${suite}@example.test`],
    [bob, `bob-${suite}@example.test`],
  ]) {
    await database
      .insert(users)
      .values({ id: id as string, email: email as string, name: id as string })
      .onConflictDoNothing();
  }
  for (const [id, owner] of [
    [aliceBot, alice],
    // Unowned Bots are deployment-published Bots visible to every user.
    [sharedBot, null],
  ] as const) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        ownerUserId: owner,
        title: id,
        roleDescription: "For a test.",
        avatarSeed: id,
        visibility: "private",
      })
      .onConflictDoNothing();
  }

  const write = async (slug: string, ownerUserId: string | null) =>
    store.installSkill({
      slug,
      title: slug,
      summary: "",
      instructions: "Do the thing.",
      ownerUserId,
      by: `${ownerUserId ?? "an administrator"}`,
    });
  aliceSkillId = (await write(aliceSkill, alice)).id;
  bobSkillId = (await write(bobSkill, bob)).id;
  deploymentSkillId = (await write(deploymentSkill, null)).id;
});

afterAll(async () => {
  await database
    .delete(skills)
    .where(
      inArray(skills.slug, [
        aliceSkill,
        bobSkill,
        deploymentSkill,
        `written-${suite}`,
      ]),
    );
  await database
    .delete(agents)
    .where(inArray(agents.id, [aliceBot, sharedBot]));
  await database.delete(users).where(inArray(users.id, [alice, bob]));
});

describe("what a person sees", () => {
  test("their own skills and the deployment's, and nobody else's", async () => {
    const slugs = (await store.listSkills({ id: alice, isAdmin: false })).map(
      (skill) => skill.slug,
    );

    expect(slugs).toContain(aliceSkill);
    expect(slugs).toContain(deploymentSkill);
    // The property the whole design rests on: one person's skill is not another person's business.
    expect(slugs).not.toContain(bobSkill);
  });

  test("an administrator sees every skill, including other people's", async () => {
    const slugs = (await store.listSkills({ id: alice, isAdmin: true })).map(
      (skill) => skill.slug,
    );

    expect(slugs).toContain(aliceSkill);
    expect(slugs).toContain(bobSkill);
    expect(slugs).toContain(deploymentSkill);
  });
});

describe("who owns what", () => {
  test("a skill written by a person belongs to that person", async () => {
    expect(await store.skillOwner(aliceSkill)).toBe(alice);
  });

  test("a skill written for the deployment belongs to nobody", async () => {
    expect(await store.skillOwner(deploymentSkill)).toBeNull();
  });

  test("a skill nobody wrote is absent rather than unowned", async () => {
    // Told apart from the line above, because "no such skill" and "the deployment's" are different
    // answers and a route that confuses them would let anybody edit a name nobody has taken.
    expect(await store.skillOwner(`nothing-${suite}`)).toBeUndefined();
  });

  test("a Bot somebody made belongs to them, and a published one to nobody", async () => {
    expect(await store.agentOwner(aliceBot)).toBe(alice);
    expect(await store.agentOwner(sharedBot)).toBeNull();
    expect(await store.agentOwner(`nothing_${suite}`)).toBeUndefined();
  });
});

describe("editing keeps ownership", () => {
  test("rewriting a skill by its id does not change whose it is, whatever is sent", async () => {
    await store.installSkill({
      id: aliceSkillId,
      slug: aliceSkill,
      title: "Edited",
      summary: "",
      instructions: "Do the thing differently.",
      // What a route would send for somebody else. The write must not honour it: whose a skill is
      // cannot be changed by saving it again.
      ownerUserId: bob,
      by: bob,
    });

    expect(await store.skillOwner(aliceSkillId)).toBe(alice);
    const mine = (await store.listSkills({ id: alice, isAdmin: false })).find(
      (skill) => skill.id === aliceSkillId,
    );
    expect(mine?.instructions).toBe("Do the thing differently.");
  });

  test("saving the same name as somebody else writes that person's own skill, and leaves the first alone", async () => {
    const theirs = await store.installSkill({
      slug: aliceSkill,
      title: "Bob's",
      summary: "",
      instructions: "Bob's own words.",
      ownerUserId: bob,
      by: bob,
    });

    expect(theirs.id).not.toBe(aliceSkillId);
    expect(await store.skillOwner(theirs.id)).toBe(bob);
    expect(await store.skillOwner(aliceSkillId)).toBe(alice);
    const alices = (await store.listSkills({ id: alice, isAdmin: false })).find(
      (skill) => skill.id === aliceSkillId,
    );
    expect(alices?.instructions).toBe("Do the thing differently.");
    await store.uninstallSkill(theirs.id, bob, { id: bob, isAdmin: false });
  });
});

/**
 * The rules as the HTTP surface enforces them, driven as a non-administrator.
 *
 * Driven here rather than through the running app because the shipped development default treats
 * every request as one local administrator, so every one of these checks short-circuits on a laptop
 * and a hole would stay hidden until a real identity provider is wired up.
 */
function routesAs(actor: {
  id: string;
  email: string;
  role: "admin" | "user";
}) {
  return createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", actor as never);
      await next();
    },
    // These cover who may GRANT a skill, which is a separate question from who may act as the Bot it
    // is granted to. That one is `bot-access.test.ts`.
    async () => true,
  );
}

const asAlice = () =>
  routesAs({ id: alice, email: "alice@example.test", role: "user" });

const grantBody = (ref: string, agentId: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "skill", ref, agentId }),
});

describe("what a person may do over HTTP", () => {
  test("writes their own skill", async () => {
    const response = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: `written-${suite}`,
        title: "Written",
        instructions: "Do it.",
      }),
    });

    expect(response.status).toBe(200);
    expect(await store.skillOwner(`written-${suite}`)).toBe(alice);
  });

  test("cannot write one for the whole deployment", async () => {
    const response = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: `global-${suite}`,
        title: "Global",
        instructions: "Do it.",
        global: true,
      }),
    });

    expect(response.status).toBe(403);
    expect(await store.skillOwner(`global-${suite}`)).toBeUndefined();
  });

  test("cannot edit or delete somebody else's", async () => {
    // By id: another person's skill is answered as no skill at all, exactly as an id nobody has.
    const edit = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: bobSkillId,
        slug: bobSkill,
        title: "Taken",
        instructions: "Mine now.",
      }),
    });
    const missing = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `sk_nothing_${suite}`,
        slug: bobSkill,
        title: "Taken",
        instructions: "Mine now.",
      }),
    });
    const remove = await asAlice().request(`/skills/${bobSkillId}`, {
      method: "DELETE",
    });

    expect(edit.status).toBe(404);
    expect(await edit.json()).toEqual(await missing.json());
    // What she is not shown is answered as no skill at all, and nothing is deleted.
    expect(remove.status).toBe(404);
    expect(await store.skillOwner(bobSkillId)).toBe(bob);
    const bobs = (await store.listSkills({ id: bob, isAdmin: false })).find(
      (skill) => skill.id === bobSkillId,
    );
    expect(bobs?.instructions).toBe("Do the thing.");
  });

  test("the same name, saved without an id, is the person's own skill and not Bob's", async () => {
    const response = await asAlice().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: bobSkill,
        title: "Alice's take",
        instructions: "Alice's words.",
      }),
    });

    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect(id).not.toBe(bobSkillId);
    expect(await store.skillOwner(id)).toBe(alice);
    expect(await store.skillOwner(bobSkillId)).toBe(bob);
    await store.uninstallSkill(id, alice, { id: alice, isAdmin: false });
  });

  test("cannot edit the deployment's, which is an administrator's to keep", async () => {
    const response = await asAlice().request(`/skills/${deploymentSkillId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(403);
    expect(await store.skillOwner(deploymentSkillId)).toBeNull();
  });

  test("puts their own skill on a Bot they own", async () => {
    const response = await asAlice().request(
      "/grants",
      grantBody(aliceSkillId, aliceBot),
    );

    expect(response.status).toBe(200);
    const held = await store.listForAgent(aliceBot);
    expect(held.skills.map((skill) => skill.slug)).toContain(aliceSkill);
  });

  test("cannot put it on a Bot the deployment shares", async () => {
    // The one that matters most: a skill one person wrote would otherwise change how a Bot that
    // everybody uses answers everybody.
    const response = await asAlice().request(
      "/grants",
      grantBody(aliceSkillId, sharedBot),
    );

    expect(response.status).toBe(403);
    expect((await store.listForAgent(sharedBot)).skills).toEqual([]);
  });

  test("cannot enable an MCP tool on anything", async () => {
    const response = await asAlice().request("/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "mcp",
        ref: "slack/slack_search_public",
        agentId: aliceBot,
      }),
    });

    expect(response.status).toBe(403);
    expect((await store.listForAgent(aliceBot)).tools).toEqual([]);
  });

  test("sees the deployment's skills and their own, and not somebody else's", async () => {
    const body = (await (await asAlice().request("/")).json()) as {
      skills: { slug: string }[];
    };
    const slugs = body.skills.map((skill) => skill.slug);

    expect(slugs).toContain(aliceSkill);
    expect(slugs).toContain(deploymentSkill);
    expect(slugs).not.toContain(bobSkill);
  });
});
