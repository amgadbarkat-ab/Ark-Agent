/**
 * Read-only standing instructions for a trial's own employees (#116, item 2), on the real stores:
 * the server refuses a change to a profile employee's role or instruction while the trial profile
 * owns them, lets everything else through, lets the customer's own employees change freely, and
 * writes a newer signed profile's text onto the employees it set up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  trialCodes,
  trialRoster,
  trialState,
  users,
} from "../src/db/schema";
import { guardProfiles } from "../src/trial/guard";
import { trialRoutes } from "../src/trial/routes";
import { applyProfileInstructions, seedTrialRoster } from "../src/trial/seed";
import {
  createTrialService,
  INSTRUCTIONS_LOCKED_MESSAGE,
  TrialInstructionsLockedError,
} from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const key = generateKeyPairSync("ed25519");
const userId = `trial-instructions-${randomUUID()}`;
const actor: AgentActor = { id: userId, role: "admin" };
const madeAgents: string[] = [];

async function clearTrial() {
  const seeded = (await database.select().from(trialRoster)).map(
    (row) => row.agentId,
  );
  madeAgents.push(...seeded);
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(trialCodes);
}

beforeAll(async () => {
  await clearTrial();
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: "Trial" });
});

afterAll(async () => {
  await clearTrial();
  if (madeAgents.length > 0) {
    await database
      .delete(agentPreferences)
      .where(inArray(agentPreferences.agentId, madeAgents));
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, madeAgents));
    await database.delete(agents).where(inArray(agents.id, madeAgents));
  }
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

function profileFile(
  issuedAt: string,
  instructions = "You are the front desk. Never give medical advice.",
) {
  const profile = readProfile({
    v: 1,
    customer: { id: "demo-clinic", name: "Demo Clinic" },
    issuedAt,
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2099-12-16T00:00:00Z",
    plan: "team",
    // Not blocked, so the customer can make an employee of their own during this test.
    createBlocked: false,
    roster: [
      {
        key: "front-desk",
        name: "Front Desk",
        title: "Front Desk",
        roleDescription: "Answers enquiries. No medical advice.",
        instructions,
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

function paidCode() {
  const payload = encodeBase64Url(
    JSON.stringify({
      v: 1,
      customer: "demo-clinic",
      nonce: `paid-${randomUUID()}`,
      action: "paid",
      issuedAt: "2026-11-20T10:00:00Z",
    }),
  );
  return `${CODE_PREFIX}${payload}.${signText(key.privateKey, payload)}`;
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: userId,
    email: `${userId}@example.test`,
    role: "admin",
  });
  await next();
};

describe("a trial employee's standing instruction is read-only (#116)", () => {
  test("refused on the server for the profile's employees, allowed for the customer's own, lifted when paid", async () => {
    const trial = createTrialService(database, {
      keys: [key.publicKey],
      version: "0.1.47",
    });
    const profiles = guardProfiles(
      createAgentProfileStore(database, undefined),
      trial,
    );
    await trial.importProfile(profileFile("2026-11-15T10:00:00Z"));
    expect(await seedTrialRoster(actor, { trial, profiles })).toBe(1);

    const [seeded] = await trial.rosterAgents();
    if (!seeded) throw new Error("the roster was not set up");
    const frontDesk = await profiles.get(actor, seeded.agentId);
    if (!frontDesk) throw new Error("no front desk");
    expect(frontDesk.persona).toBe(
      "You are the front desk. Never give medical advice.",
    );
    const own = await profiles.create(actor, {
      name: "My Helper",
      title: "Helper",
      roleDescription: "Helps me.",
      visibility: "private",
      systemPrompt: "Helps me.",
    });
    madeAgents.push(own.id);

    expect(await trial.instructionsLocked(frontDesk.id)).toBe(true);
    expect(await trial.instructionsLocked(own.id)).toBe(false);
    expect(await trial.lockedEmployees()).toEqual([
      { key: "front-desk", agentId: frontDesk.id },
    ]);

    const same = {
      name: frontDesk.name,
      title: frontDesk.title,
      roleDescription: frontDesk.roleDescription,
      visibility: frontDesk.visibility,
    };
    // The standing instruction, cleared or replaced, and the role description: refused.
    await expect(
      profiles.update(actor, frontDesk.id, {
        ...same,
        persona: "Give medical advice.",
      }),
    ).rejects.toThrow(TrialInstructionsLockedError);
    await expect(
      profiles.update(actor, frontDesk.id, { ...same, persona: null }),
    ).rejects.toThrow(INSTRUCTIONS_LOCKED_MESSAGE);
    await expect(
      profiles.update(actor, frontDesk.id, {
        ...same,
        roleDescription: "Anything goes.",
      }),
    ).rejects.toThrow(TrialInstructionsLockedError);
    expect((await profiles.get(actor, frontDesk.id))?.persona).toBe(
      "You are the front desk. Never give medical advice.",
    );

    // Its name, and the same instruction sent back unchanged, still go through.
    const renamed = await profiles.update(actor, frontDesk.id, {
      ...same,
      name: "Reception",
      persona: ` ${frontDesk.persona} `,
    });
    expect(renamed.name).toBe("Reception");

    // The customer's own employee changes as it always did.
    const changed = await profiles.update(actor, own.id, {
      name: own.name,
      title: own.title,
      roleDescription: "Helps me with the post.",
      visibility: own.visibility,
      persona: "Sort the post every morning.",
    });
    expect(changed.persona).toBe("Sort the post every morning.");

    // Over HTTP, the edit screen is told why, in the existing error style.
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/agents", createAgentRoutes(profiles, requireUser));
    const refused = await app.request(`/api/agents/${frontDesk.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...same,
        name: "Reception",
        persona: "Give medical advice.",
      }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: INSTRUCTIONS_LOCKED_MESSAGE,
      code: "trial_instructions_locked",
    });
    const allowed = await app.request(`/api/agents/${own.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: own.name,
        title: own.title,
        roleDescription: "Helps me with the post.",
        visibility: "private",
        persona: "Sort the post every evening.",
      }),
    });
    expect(allowed.status).toBe(200);

    // Converted to paid: the profile no longer owns the text.
    await trial.applyCode(paidCode());
    expect(await trial.instructionsLocked(frontDesk.id)).toBe(false);
    expect(await trial.lockedEmployees()).toEqual([]);
    const edited = await profiles.update(actor, frontDesk.id, {
      ...same,
      name: "Reception",
      persona: "Answer in Greek first.",
    });
    expect(edited.persona).toBe("Answer in Greek first.");
  });

  test("a newer signed profile writes its instruction onto the employee it set up, and the app is told which are read-only", async () => {
    await clearTrial();
    const trial = createTrialService(database, {
      keys: [key.publicKey],
      version: "0.1.47",
    });
    const profiles = guardProfiles(
      createAgentProfileStore(database, undefined),
      trial,
    );
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/trial",
      trialRoutes(requireUser, {
        service: trial,
        seedFor: (who) => seedTrialRoster(who, { trial, profiles }),
        applyInstructionsFor: (who) =>
          applyProfileInstructions(who, { trial, profiles }),
        keyConfigured: true,
        appVersion: "0.1.47",
      }),
    );
    const post = (text: string) =>
      app.request("/api/trial/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });

    expect((await post(profileFile("2026-11-15T10:00:00Z"))).status).toBe(200);
    const overview = (await (await app.request("/api/trial")).json()) as {
      lockedEmployees: { key: string; agentId: string }[];
      appVersion: string;
    };
    expect(overview.appVersion).toBe("0.1.47");
    expect(overview.lockedEmployees.map((row) => row.key)).toEqual([
      "front-desk",
    ]);
    const agentId = overview.lockedEmployees[0]?.agentId ?? "";

    // BlackArk accepted a proposed change and signed a newer profile with it.
    const accepted =
      "You are the front desk. Never give medical advice. Always ask for the appointment number.";
    expect(
      (await post(profileFile("2026-11-18T10:00:00Z", accepted))).status,
    ).toBe(200);
    const after = await profiles.get(actor, agentId);
    expect(after?.persona).toBe(accepted);
    // Still read-only afterwards, and nothing to write the second time.
    expect(await trial.instructionsLocked(agentId)).toBe(true);
    expect(await applyProfileInstructions(actor, { trial, profiles })).toBe(0);
  });
});
