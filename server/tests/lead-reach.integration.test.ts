import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createLeadReach } from "../src/agents/lead-reach";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
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

const leadMayAddress = createLeadReach(database);

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
