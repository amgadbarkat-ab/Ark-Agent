import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  pluginGrants,
  skills,
  skillTools,
  users,
} from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A skill's `/name` belongs to whoever wrote it.
 *
 * Two customers each have a `/standup`; neither is told about the other, neither can reach the other's,
 * and a Bot only ever runs the instructions of the skill that was put on it. What stays shared is the
 * deployment's own names, which every signed-in person can already see.
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
const admin = `user_admin_${suite}`;
const aliceBot = `agent_alice_${suite}`;
const bobBot = `agent_bob_${suite}`;
const name = `standup-${suite}`;
const deploymentName = `triage-${suite}`;

beforeAll(async () => {
  for (const id of [alice, bob, admin]) {
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id })
      .onConflictDoNothing();
  }
  for (const [id, owner] of [
    [aliceBot, alice],
    [bobBot, bob],
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
});

afterAll(async () => {
  await database.delete(skills).where(like(skills.slug, `%-${suite}`));
  await database.delete(skills).where(like(skills.id, `legacy-${suite}%`));
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, [aliceBot, bobBot]));
  await database.delete(agents).where(inArray(agents.id, [aliceBot, bobBot]));
  await database.delete(users).where(inArray(users.id, [alice, bob, admin]));
});

type Actor = { id: string; role: "admin" | "user" };
const routesAs = (actor: Actor) =>
  createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", {
        ...actor,
        email: `${actor.id}@example.test`,
      } as never);
      await next();
    },
    async () => true,
  );
const asAlice = () => routesAs({ id: alice, role: "user" });
const asBob = () => routesAs({ id: bob, role: "user" });
const asAdmin = () => routesAs({ id: admin, role: "admin" });
type Routes = ReturnType<typeof routesAs>;

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const write = async (
  routes: Routes,
  slug: string,
  instructions: string,
  extra: Record<string, unknown> = {},
) => {
  const response = await routes.request(
    "/skills",
    json("POST", { slug, title: slug, instructions, ...extra }),
  );
  return {
    status: response.status,
    body: (await response.json()) as { id?: string; error?: string },
  };
};
const grant = (routes: Routes, ref: string, agentId: string) =>
  routes.request("/grants", json("POST", { kind: "skill", ref, agentId }));
const listed = async (routes: Routes) =>
  (
    (await (await routes.request("/")).json()) as {
      skills: { id: string; slug: string; instructions: string }[];
    }
  ).skills;
const instructionsOn = async (routes: Routes, agentId: string) =>
  (
    (await (await routes.request(`/for/${agentId}`)).json()) as {
      skills: { slug: string; instructions: string }[];
    }
  ).skills.map((skill) => skill.instructions);

let aliceId = "";
let bobId = "";

describe("two customers with the same name", () => {
  test("both can have it, and neither is told it was ever taken", async () => {
    const first = await write(asAlice(), name, "Alice: what did you do?");
    const second = await write(asBob(), name, "Bob: three bullets.");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    aliceId = first.body.id as string;
    bobId = second.body.id as string;
    expect(aliceId).not.toBe(bobId);
  });

  test("each sees their own and not the other's", async () => {
    const alices = (await listed(asAlice())).filter(
      (skill) => skill.slug === name,
    );
    const bobs = (await listed(asBob())).filter((skill) => skill.slug === name);

    expect(alices.map((skill) => skill.instructions)).toEqual([
      "Alice: what did you do?",
    ]);
    expect(bobs.map((skill) => skill.instructions)).toEqual([
      "Bob: three bullets.",
    ]);
  });

  test("saving it again changes only their own", async () => {
    const again = await write(asAlice(), name, "Alice: and what next?");

    expect(again.body.id).toBe(aliceId);
    const bobs = (await listed(asBob())).find((skill) => skill.id === bobId);
    expect(bobs?.instructions).toBe("Bob: three bullets.");
  });

  test("by name, grants and removal mean the person's own", async () => {
    // A name on its own is read for whoever is asking, so a client that predates ids still works.
    expect((await grant(asAlice(), name, aliceBot)).status).toBe(200);
    expect((await grant(asBob(), name, bobBot)).status).toBe(200);

    // What each Bot is told is its own owner's skill: no cross-talk between the two.
    expect(await instructionsOn(asAlice(), aliceBot)).toEqual([
      "Alice: and what next?",
    ]);
    expect(await instructionsOn(asBob(), bobBot)).toEqual([
      "Bob: three bullets.",
    ]);
  });

  test("removing yours leaves theirs, and its grant, as they were", async () => {
    const removed = await asAlice().request(`/skills/${name}`, {
      method: "DELETE",
    });

    expect(removed.status).toBe(200);
    expect(await instructionsOn(asAlice(), aliceBot)).toEqual([]);
    expect(await instructionsOn(asBob(), bobBot)).toEqual([
      "Bob: three bullets.",
    ]);
  });

  test("another person's skill cannot be named by its id either, to read, grant or remove", async () => {
    expect((await grant(asAlice(), bobId, aliceBot)).status).toBe(404);
    const gone = await asAlice().request(`/skills/${bobId}`, {
      method: "DELETE",
    });
    const nothing = await asAlice().request(`/skills/sk_none_${suite}`, {
      method: "DELETE",
    });
    // The same answer for his skill as for one that was never there.
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual(await nothing.json());
    // Still there, still Bob's, still on his Bot.
    expect((await listed(asBob())).some((skill) => skill.id === bobId)).toBe(
      true,
    );
    expect(await instructionsOn(asBob(), bobBot)).toEqual([
      "Bob: three bullets.",
    ]);
    // The refusal for an id that is not hers reads the same as for one that does not exist.
    const unknown = await grant(asAlice(), `sk_none_${suite}`, aliceBot);
    expect(unknown.status).toBe(404);
  });
});

describe("the deployment's own names", () => {
  test("a person cannot take one, and is told only what everybody can already see", async () => {
    expect(
      (
        await write(asAdmin(), deploymentName, "Triage by severity.", {
          global: true,
        })
      ).status,
    ).toBe(200);

    const taken = await write(asAlice(), deploymentName, "Alice's triage.");

    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe(
      `/${deploymentName} is a skill this deployment provides. Pick another name for yours.`,
    );
  });

  test("an administrator can write one under a name a person already uses, and no person can stop that", async () => {
    // Bob has his own `name`; an administrator writes one for everybody under the same name.
    const global = await write(asAdmin(), name, "House standup.", {
      global: true,
    });
    expect(global.status).toBe(200);
    // Bob's own is untouched.
    expect(
      (await listed(asBob())).find((skill) => skill.id === bobId)?.instructions,
    ).toBe("Bob: three bullets.");
  });

  test("a deployment name is still one skill, and writing it again is an edit", async () => {
    const again = await write(asAdmin(), deploymentName, "Triage, revised.", {
      global: true,
    });
    const all = (await listed(asAdmin())).filter(
      (skill) => skill.slug === deploymentName,
    );

    expect(again.status).toBe(200);
    expect(all).toHaveLength(1);
    expect(all[0]?.instructions).toBe("Triage, revised.");
  });
});

describe("one Bot, one meaning for a name", () => {
  test("it cannot hold two skills under one name", async () => {
    const globalId = (await listed(asAdmin())).find(
      (skill) => skill.slug === name && skill.instructions === "House standup.",
    )?.id as string;
    // Bob's own `name` is on his Bot already. The deployment's, with the same name, is refused there.
    const refused = await grant(asAdmin(), globalId, bobBot);

    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      `/${name}`,
    );
    expect(await instructionsOn(asBob(), bobBot)).toEqual([
      "Bob: three bullets.",
    ]);
    // On a Bot that holds no skill by that name, it goes on.
    expect((await grant(asAdmin(), globalId, aliceBot)).status).toBe(200);
  });
});

describe("the one-name-per-Bot rule gives nothing away", () => {
  test("trying to put a skill on somebody else's Bot says the same whether or not that Bot holds the name", async () => {
    // Bob's Bot holds a skill called `held`. Alice writes her own under that name and tries it on his
    // Bot; and, as a control, tries a name his Bot does not hold. Both are refused as not hers to do,
    // so the refusal cannot be used to find out which names somebody else's Bot has.
    const held = `held-${suite}`;
    const bobs = await write(asBob(), held, "Bob's.");
    expect((await grant(asBob(), bobs.body.id as string, bobBot)).status).toBe(
      200,
    );
    const same = await write(asAlice(), held, "Alice's own.");
    const other = await write(asAlice(), `other-${suite}`, "Alice's other.");
    expect(same.status).toBe(200);
    const holding = await grant(asAlice(), same.body.id as string, bobBot);
    const control = await grant(asAlice(), other.body.id as string, bobBot);

    expect(holding.status).toBe(403);
    expect(control.status).toBe(403);
    expect(await holding.json()).toEqual(await control.json());
  });
});

describe("editing", () => {
  test("by id, an administrator can rewrite a person's skill and it stays theirs", async () => {
    const edit = await write(asAdmin(), name, "Reviewed by staff.", {
      id: bobId,
    });

    expect(edit.status).toBe(200);
    expect(edit.body.id).toBe(bobId);
    const bobs = (await listed(asBob())).find((skill) => skill.id === bobId);
    expect(bobs?.instructions).toBe("Reviewed by staff.");
    expect(await store.skillOwner(bobId)).toBe(bob);
  });

  test("a person editing by id cannot reach the deployment's, which is an administrator's", async () => {
    const globalId = (await listed(asAdmin())).find(
      (skill) => skill.slug === deploymentName,
    )?.id as string;
    const edit = await write(asAlice(), deploymentName, "Mine now.", {
      id: globalId,
    });

    expect(edit.status).toBe(403);
  });

  test("an id that is not text is refused", async () => {
    const bad = await write(asAlice(), name, "x", { id: 5 });
    expect(bad.status).toBe(400);
  });

  test("a declared tool follows the id, not the name", async () => {
    const one = await write(asAlice(), `a-tools-${suite}`, "One.");
    const two = await write(asBob(), `a-tools-${suite}`, "Two.");
    await database.insert(skillTools).values({
      skillId: one.body.id as string,
      ref: "nobody/anything",
      declaredBy: null,
    });

    const rows = await database
      .select()
      .from(skillTools)
      .where(
        inArray(skillTools.skillId, [one.body.id, two.body.id] as string[]),
      );
    expect(rows.map((row) => row.skillId)).toEqual([one.body.id as string]);
    // Taking away Bob's does not take away Alice's.
    await store.uninstallSkill(two.body.id as string, bob, {
      id: bob,
      isAdmin: false,
    });
    expect(
      (
        await database
          .select()
          .from(skillTools)
          .where(eq(skillTools.skillId, one.body.id as string))
      ).length,
    ).toBe(1);
  });
});

describe("skills written before names were per owner", () => {
  test("keep working: their name is their id, and a grant made then still means them", async () => {
    const legacyId = `legacy-${suite}`;
    await database.insert(skills).values({
      id: legacyId,
      slug: legacyId,
      ownerUserId: alice,
      title: "Old",
      summary: "",
      instructions: "From before.",
      origin: "yours",
    });
    await database.insert(pluginGrants).values({
      kind: "skill",
      ref: legacyId,
      agentId: aliceBot,
      grantedBy: "an earlier release",
    });

    expect(await instructionsOn(asAlice(), aliceBot)).toContain("From before.");
    // And it can be removed by its old reference, which is its name.
    const removed = await asAlice().request(`/skills/${legacyId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await instructionsOn(asAlice(), aliceBot)).not.toContain(
      "From before.",
    );
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, legacyId)),
    ).toEqual([]);
  });

  test("a name that is another customer's old id is not read as theirs", async () => {
    const legacyId = `legacy-${suite}-b`;
    await database.insert(skills).values({
      id: legacyId,
      slug: legacyId,
      ownerUserId: alice,
      title: "Old",
      summary: "",
      instructions: "Alice's old one.",
      origin: "yours",
    });
    // Bob writes his own under the very same name; his gets an id of its own.
    const bobs = await write(asBob(), legacyId, "Bob's, same name.");
    expect(bobs.status).toBe(200);

    // Bob names it as he sees it; he is not handed Alice's skill, and not refused for it either.
    const granted = await grant(asBob(), legacyId, bobBot);
    expect(granted.status).toBe(200);
    expect(await instructionsOn(asBob(), bobBot)).toContain(
      "Bob's, same name.",
    );
    expect(await instructionsOn(asBob(), bobBot)).not.toContain(
      "Alice's old one.",
    );
  });
});

describe("the database holds the line", () => {
  test("one owner cannot have a name twice, and the deployment cannot either", async () => {
    const dupe = async (ownerUserId: string | null) => {
      await database.insert(skills).values({
        id: `sk_raw_${randomUUID()}`,
        slug: `raw-${suite}`,
        ownerUserId,
        title: "x",
        summary: "",
        instructions: "x",
        origin: "yours",
      });
    };
    await dupe(alice);
    await expect(dupe(alice)).rejects.toThrow();
    await dupe(bob);
    await dupe(null);
    await expect(dupe(null)).rejects.toThrow();
  });

  test("two saves of one new name at once make one skill", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => write(asAlice(), `race-${suite}`, `Draft ${n}`)),
    );

    expect(results.every((result) => result.status === 200)).toBe(true);
    const mine = (await listed(asAlice())).filter(
      (skill) => skill.slug === `race-${suite}`,
    );
    expect(mine).toHaveLength(1);
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
  });
});
