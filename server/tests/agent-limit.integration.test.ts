/**
 * Ark Team's agent limit (v0.1.49): agents per seat times seats, for the whole install, on the real
 * activation service and the real profile store. At the limit a new digital employee is refused with an
 * audit row and an English and Greek sentence; nothing that exists is ever removed, hidden or stopped.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import type { Entitlement } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createDatabase } from "../src/db/client";
import {
  activationState,
  agentPreferences,
  agentProfiles,
  agents,
  trialCodes,
  trialRoster,
  trialState,
  users,
} from "../src/db/schema";
import { createActivationService } from "../src/trial/activation";
import {
  AgentLimitReachedError,
  countOwnedAgents,
  createAgentLimit,
} from "../src/trial/agent-limit";
import { guardProfiles } from "../src/trial/guard";
import { activationRoutes } from "../src/trial/routes";
import { createTrialService } from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const trialKey = generateKeyPairSync("ed25519");
const licenseKey = generateKeyPairSync("ed25519");
const userId = `agent-limit-${randomUUID()}`;
const actor: AgentActor = { id: userId, role: "admin" };

async function clearAgents() {
  const mine = (
    await database
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, userId))
  ).map((row) => row.id);
  if (mine.length > 0) {
    await database
      .delete(agentPreferences)
      .where(inArray(agentPreferences.agentId, mine));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, mine));
    await database.delete(agents).where(inArray(agents.id, mine));
  }
}

async function clear() {
  await clearAgents();
  await database.delete(activationState);
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(trialCodes);
}

beforeEach(async () => {
  await clear();
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: "Limit" })
    .onConflictDoNothing();
});
afterAll(async () => {
  await clear();
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

let nonce = 0;
function signed(payload: Record<string, unknown>, key: KeyObject) {
  nonce += 1;
  const encoded = encodeBase64Url(
    JSON.stringify({
      v: 1,
      customer: "demo-shop",
      nonce: `nonce-${nonce}-abcdef`,
      issuedAt: "2026-11-19T08:00:00Z",
      ...payload,
    }),
  );
  return `${CODE_PREFIX}${encoded}.${signText(key, encoded)}`;
}

const license = (over: Record<string, unknown> = {}) =>
  signed(
    {
      action: "license",
      plan: "team",
      seats: 1,
      validUntil: "2026-12-24T00:00:00Z",
      ...over,
    },
    licenseKey.privateKey,
  );

function profileFile(rosterSize: number) {
  const profile = readProfile({
    v: 1,
    customer: { id: "demo-shop", name: "Demo Shop" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2026-12-16T00:00:00Z",
    plan: "team",
    createBlocked: false,
    roster: Array.from({ length: rosterSize }, (_, index) => ({
      key: `employee-${index + 1}`,
      name: `Employee ${index + 1}`,
      title: "Front Desk",
      roleDescription: "Answers enquiries.",
      instructions: "Draft every reply for approval.",
    })),
  });
  const encoded = encodeBase64Url(JSON.stringify(profile));
  return JSON.stringify({
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(trialKey.privateKey, encoded),
  });
}

const base: Entitlement = {
  tenantId: "t",
  planId: "internal",
  planName: "Internal",
  subscriptionStatus: "active",
  maxActiveBots: null,
  canRun: true,
};

/** Only this test's employees, so rows other test files leave behind never shift the count. */
async function countMine(): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.ownerUserId, userId),
        isNull(agentProfiles.deletedAt),
      ),
    );
  return Number(row?.value ?? 0);
}

function harness() {
  const audited: { eventType: string; payload: Record<string, unknown> }[] = [];
  const trial = createTrialService(database, {
    keys: [trialKey.publicKey],
    version: "0.1.49",
    now: () => new Date("2026-11-19T09:00:00Z"),
  });
  const activation = createActivationService(database, {
    required: true,
    trialKeys: [trialKey.publicKey],
    licenseKeys: [licenseKey.publicKey],
    trial,
    version: "0.1.49",
    now: () => new Date("2026-11-19T09:00:00Z"),
  });
  const limit = createAgentLimit({
    activation,
    countAgents: countMine,
    isSeeding: () => trial.isSeeding(),
    audit: async (event) => {
      audited.push(event);
    },
  });
  const profiles = guardProfiles(
    createAgentProfileStore(database, undefined),
    activation,
    limit,
  );
  const add = (name: string) =>
    profiles.create(actor, {
      name,
      title: "x",
      roleDescription: "x",
      visibility: "private",
      systemPrompt: "x",
    });
  return { trial, activation, limit, profiles, add, audited };
}

async function fill(add: (name: string) => Promise<unknown>, how: number) {
  for (let index = 0; index < how; index += 1) await add(`Made ${index + 1}`);
}

describe("Ark Team's agent limit (v0.1.49)", () => {
  test("at the limit, the next one is refused with an audit row and both sentences", async () => {
    const { activation, limit, add, audited } = harness();
    await activation.apply(license({ maxAgents: 5 }));
    await fill(add, 5);
    expect(await limit.allowance()).toMatchObject({
      limit: 5,
      inUse: 5,
      canAdd: false,
      agentsPerSeat: 5,
      seats: 1,
    });
    const refused = await add("Sixth").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentLimitReachedError);
    const error = refused as AgentLimitReachedError;
    expect(error.message).toContain("allows 5 digital employees");
    expect(error.message).toContain(
      "move up to 10 digital employees per person",
    );
    expect(error.notice.el).toContain("περάστε στους 10 ψηφιακούς υπαλλήλους");
    expect(audited).toEqual([
      {
        eventType: "agent.limit_refused",
        actorUserId: userId,
        payload: {
          path: "create",
          limit: 5,
          inUse: 5,
          agentsPerSeat: 5,
          seats: 1,
          planId: "team",
        },
      },
    ]);
    expect(await countMine()).toBe(5);
  });

  test("two adds at the same moment with one place left: only one gets through", async () => {
    const { activation, add, profiles } = harness();
    await activation.apply(license({ maxAgents: 5 }));
    await fill(add, 4);
    const [first] = await profiles.list(actor);
    const results = await Promise.allSettled([
      add("Racer A"),
      add("Racer B"),
      profiles.duplicate(actor, first?.id ?? ""),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(
      results.filter(
        (r) =>
          r.status === "rejected" && r.reason instanceof AgentLimitReachedError,
      ).length,
    ).toBe(2);
    expect(await countMine()).toBe(5);
  });

  test("each tier allows its own number", async () => {
    for (const maxAgents of [5, 10, 20]) {
      await clear();
      const { activation, add, limit } = harness();
      await activation.apply(license({ maxAgents }));
      await fill(add, maxAgents);
      expect((await limit.allowance()).canAdd).toBe(false);
      await expect(add("One more")).rejects.toBeInstanceOf(
        AgentLimitReachedError,
      );
    }
  });

  test("seats times tier: 3 seats on the 10 tier is 30", async () => {
    const { activation, limit } = harness();
    await activation.apply(license({ maxAgents: 10, seats: 3 }));
    expect(await limit.allowance()).toMatchObject({
      limit: 30,
      agentsPerSeat: 10,
      seats: 3,
      canAdd: true,
    });
    expect((await activation.current()).agentLimit).toBe(30);
  });

  test("a key from before the tiers counts as 5 per seat", async () => {
    const { activation, add, limit } = harness();
    await activation.apply(license({ seats: 2 }));
    expect(await limit.allowance()).toMatchObject({
      limit: 10,
      agentsPerSeat: 5,
    });
    await fill(add, 10);
    await expect(add("Eleventh")).rejects.toBeInstanceOf(
      AgentLimitReachedError,
    );
  });

  test("above the limit after a downgrade: everything stays and runs, only adding stops", async () => {
    const { activation, add, limit, profiles, audited } = harness();
    await activation.apply(license({ maxAgents: 10 }));
    await fill(add, 7);
    // The portal switch to the 5 tier: the renewed key, valid longer, says 5.
    await activation.apply(
      license({ maxAgents: 5, validUntil: "2027-01-24T00:00:00Z" }),
    );
    expect(await limit.allowance()).toMatchObject({
      limit: 5,
      inUse: 7,
      canAdd: false,
    });
    expect((await profiles.list(actor)).length).toBe(7);
    expect((await activation.entitlement(base)).canRun).toBe(true);
    const [first] = await profiles.list(actor);
    await expect(
      profiles.duplicate(actor, first?.id ?? ""),
    ).rejects.toBeInstanceOf(AgentLimitReachedError);
    expect(audited.at(-1)?.payload).toMatchObject({
      path: "duplicate",
      inUse: 7,
      limit: 5,
    });
    // Hiding and showing one again is not adding one.
    await profiles.setHidden(actor, first?.id ?? "", true);
    await profiles.setHidden(actor, first?.id ?? "", false);
    expect(await countMine()).toBe(7);
  });

  test("at the top tier the sentence asks for another person, not another tier", async () => {
    const { activation, add } = harness();
    await activation.apply(license({ maxAgents: 20 }));
    await fill(add, 20);
    const error = (await add("21st").catch(
      (caught: unknown) => caught,
    )) as AgentLimitReachedError;
    expect(error.message).toContain("add a person to your subscription");
    expect(error.message).not.toContain("move up to");
  });

  test("a trial profile allows its own roster size; seeding it is never refused", async () => {
    const { trial, activation, profiles, limit, add } = harness();
    await trial.importProfile(profileFile(3));
    const { seedTrialRoster } = await import("../src/trial/seed");
    expect(await seedTrialRoster(actor, { trial, profiles })).toBe(3);
    expect(await limit.allowance()).toMatchObject({
      limit: 3,
      inUse: 3,
      canAdd: false,
    });
    const error = (await add("Extra").catch(
      (caught: unknown) => caught,
    )) as AgentLimitReachedError;
    expect(error).toBeInstanceOf(AgentLimitReachedError);
    expect(error.message).toContain("Your trial allows 3");
    expect((await activation.current()).agentLimit).toBe(3);
  });

  test("a trial without employees of its own, or a trial code, allows 5", async () => {
    const first = harness();
    await first.trial.importProfile(profileFile(0));
    expect((await first.limit.allowance()).limit).toBe(5);
    await clear();
    const second = harness();
    await second.activation.apply(
      signed(
        { action: "trial", plan: "team", until: "2026-12-17T00:00:00Z" },
        trialKey.privateKey,
      ),
    );
    expect(await second.limit.allowance()).toMatchObject({
      limit: 5,
      canAdd: true,
    });
  });

  test("ArkAgent and Enterprise keys, and an install without one, have no agent limit", async () => {
    const none = harness();
    expect((await none.limit.allowance()).limit).toBeNull();
    for (const plan of ["agent", "enterprise"]) {
      await clear();
      const { activation, limit } = harness();
      await activation.apply(license({ plan }));
      expect(await limit.allowance()).toMatchObject({
        limit: null,
        canAdd: true,
      });
    }
  });

  test("the app reads the allowance beside the activation, with the sentence once full", async () => {
    const { activation, limit, add } = harness();
    await activation.apply(license({ maxAgents: 5 }));
    await fill(add, 5);
    const routes = activationRoutes(
      async (context, next) => {
        context.set("actor", { id: userId, email: "a@b.c", role: "admin" });
        await next();
      },
      activation,
      undefined,
      limit,
    );
    const body = (await (await routes.request("/")).json()) as {
      activation: { agentLimit: number; agentsPerSeat: number };
      agents: {
        limit: number;
        inUse: number;
        canAdd: boolean;
        notice: { en: string; el: string };
      };
    };
    expect(body.activation).toMatchObject({ agentLimit: 5, agentsPerSeat: 5 });
    expect(body.agents).toMatchObject({ limit: 5, inUse: 5, canAdd: false });
    expect(body.agents.notice.el).toContain("Ark Team");
  });

  test("the install's count is every employee a person made, not the built-in ones", async () => {
    const { add } = harness();
    const before = await countOwnedAgents(database);
    const made = (await add("Counted")) as { id: string };
    expect(await countOwnedAgents(database)).toBe(before + 1);
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, made.id));
    expect(await countOwnedAgents(database)).toBe(before);
  });
});
