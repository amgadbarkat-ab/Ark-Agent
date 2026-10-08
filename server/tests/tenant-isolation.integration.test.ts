import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  deploymentPackages,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const MANAGED = new URL("https://managed.example.test/ag-ui");
const made = {
  users: [] as string[],
  agents: [] as string[],
  packages: [] as string[],
};

/** Two customers on a hosted service: nothing is shared between their accounts. */
const customers = createAccountStore(database, {
  billingMode: "subscriptions",
});
const customerProfiles = createAgentProfileStore(
  database,
  MANAGED,
  undefined,
  customers,
);

async function customer(label: string): Promise<AgentActor> {
  const id = `iso-${label}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.users.push(id);
  await customers.ensureTenant(id);
  return { id, role: "user" };
}

async function newAgent(
  owner: AgentActor,
  visibility: "public" | "private",
  title = "Analyst",
) {
  const profile = await customerProfiles.create(owner, {
    name: `Bot ${randomUUID().slice(0, 6)}`,
    title,
    roleDescription: "Does analysis.",
    visibility,
  } as never);
  made.agents.push(profile.id);
  return profile;
}

afterEach(async () => {
  for (const id of made.agents.splice(0))
    await database.delete(agents).where(eq(agents.id, id));
  for (const id of made.packages.splice(0))
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, id));
  for (const id of made.users.splice(0)) {
    const rows = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const row of rows)
      await database.delete(tenants).where(eq(tenants.id, row.tenantId));
  }
});
afterAll(async () => {
  await database.$client.close();
});

describe("a coworker one customer shares", () => {
  test("is never seen by another customer, even when it is marked public", async () => {
    const ann = await customer("ann");
    const bob = await customer("bob");
    const shared = await newAgent(ann, "public");
    const secret = await newAgent(ann, "private");

    const bobSees = (await customerProfiles.list(bob)).map((p) => p.id);
    expect(bobSees).not.toContain(shared.id);
    expect(bobSees).not.toContain(secret.id);
    expect(await customerProfiles.get(bob, shared.id)).toBeNull();
    expect(await customerProfiles.get(bob, secret.id)).toBeNull();

    // Her own are hers.
    const annSees = (await customerProfiles.list(ann)).map((p) => p.id);
    expect(annSees).toEqual(expect.arrayContaining([shared.id, secret.id]));
  });

  test("cannot be run, changed, duplicated, hidden or deleted by another customer", async () => {
    const ann = await customer("ann");
    const bob = await customer("bob");
    const shared = await newAgent(ann, "public");
    for (const act of [
      () =>
        customerProfiles.update(bob, shared.id, {
          name: "x",
          title: "x",
          roleDescription: "x",
          visibility: "public",
        } as never),
      () => customerProfiles.duplicate(bob, shared.id),
      () => customerProfiles.setHidden(bob, shared.id, true),
      () => customerProfiles.softDelete(bob, shared.id),
      () => customerProfiles.issueCallbackToken(bob, shared.id),
    ]) {
      await expect(act()).rejects.toThrow(/not found/i);
    }

    // The roster the runtime builds a run from is the same rule.
    const loader = createRuntimeAgentLoader(database);
    expect((await loader(bob)).map((a) => a.id)).not.toContain(shared.id);
    expect((await loader(ann)).map((a) => a.id)).toContain(shared.id);
  });

  test("is seen by the people in the same account", async () => {
    const ann = await customer("ann");
    const colleague = await customer("colleague");
    const shared = await newAgent(ann, "public");
    const secret = await newAgent(ann, "private");
    // Shared seats are not sold yet, but the model has to hold when they are.
    const tenantId = await customers.ensureTenant(ann.id);
    await database
      .delete(tenantMemberships)
      .where(eq(tenantMemberships.userId, colleague.id));
    await database
      .insert(tenantMemberships)
      .values({ tenantId, userId: colleague.id, role: "member" });

    const sees = (await customerProfiles.list(colleague)).map((p) => p.id);
    expect(sees).toContain(shared.id);
    expect(sees).not.toContain(secret.id);
    expect(
      (await createRuntimeAgentLoader(database)(colleague)).map((a) => a.id),
    ).toContain(shared.id);
  });
});

describe("the platform's own coworkers", () => {
  test("are offered to every customer, and cannot be changed by one", async () => {
    const [pkg] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: `iso-${randomUUID()}`,
        sourcePath: "test",
        checksum: randomUUID(),
      })
      .returning();
    if (!pkg) throw new Error("package");
    made.packages.push(pkg.id);
    const id = `platform-${randomUUID()}`;
    await database.insert(agents).values({
      id,
      name: id,
      type: "built_in",
      configuration: { systemPrompt: "x" },
      packageId: pkg.id,
    });
    made.agents.push(id);
    await database.insert(agentProfiles).values({
      agentId: id,
      ownerUserId: null,
      title: "Ark's own",
      roleDescription: "Ships with the platform.",
      avatarSeed: id,
      visibility: "public",
    });

    const ann = await customer("ann");
    const bob = await customer("bob");
    for (const who of [ann, bob]) {
      expect((await customerProfiles.list(who)).map((p) => p.id)).toContain(id);
    }
    await expect(
      customerProfiles.update(bob, id, {
        name: "x",
        title: "x",
        roleDescription: "x",
        visibility: "public",
      } as never),
    ).rejects.toThrow();
  });
});

describe("a coworker with an owner but no account", () => {
  test("is its owner's alone, whatever its visibility says", async () => {
    // Made without the account collaborator, as a misconfigured deployment might.
    const bare = createAgentProfileStore(database, MANAGED);
    const ann = await customer("ann");
    const bob = await customer("bob");
    const profile = await bare.create(ann, {
      name: "Bare",
      title: "Bare",
      roleDescription: "No account.",
      visibility: "public",
    } as never);
    made.agents.push(profile.id);
    expect((await bare.list(bob)).map((p) => p.id)).not.toContain(profile.id);
    expect((await bare.list(ann)).map((p) => p.id)).toContain(profile.id);
  });
});

describe("a company's own deployment", () => {
  test("keeps working the way it did: staff share their public coworkers", async () => {
    const company = createAccountStore(database, { billingMode: "internal" });
    const profiles = createAgentProfileStore(
      database,
      MANAGED,
      undefined,
      company,
    );
    const ids: string[] = [];
    for (const label of ["a", "b"]) {
      const id = `iso-staff-${label}-${randomUUID()}`;
      await database.insert(users).values({ id, email: `${id}@example.com` });
      made.users.push(id);
      ids.push(id);
    }
    const [a, b] = ids as [string, string];
    // What the sign-in guard does for each person as they arrive.
    await company.ensureTenant(a);
    await company.ensureTenant(b);
    const shared = await profiles.create({ id: a, role: "user" }, {
      name: "Shared",
      title: "Shared",
      roleDescription: "For staff.",
      visibility: "public",
    } as never);
    made.agents.push(shared.id);
    expect(
      (await profiles.list({ id: b, role: "user" })).map((p) => p.id),
    ).toContain(shared.id);
  });
});

describe("provisioning on the way in", () => {
  test("gives a signed-in person their account before the route runs, once", async () => {
    const { Hono } = await import("hono");
    const { withAccountProvisioning } = await import(
      "../src/accounts/provisioning"
    );
    const id = `iso-guard-${randomUUID()}`;
    await database.insert(users).values({ id, email: `${id}@example.com` });
    made.users.push(id);
    let ensured = 0;
    const store = createAccountStore(database, {
      billingMode: "subscriptions",
    });
    const app = new Hono().get(
      "/who",
      withAccountProvisioning(
        async (context, next) => {
          context.set("actor", {
            id,
            email: `${id}@example.com`,
            role: "user",
          });
          await next();
        },
        async (userId) => {
          ensured += 1;
          return store.ensureTenant(userId);
        },
      ),
      (context) =>
        context.json({ tenant: store.tenantIdForUser(id) ? "checked" : "" }),
    );
    expect((await app.request("/who")).status).toBe(200);
    expect(await store.tenantIdForUser(id)).toBeDefined();
    await app.request("/who");
    await app.request("/who");
    expect(ensured).toBe(1);
  });
});
