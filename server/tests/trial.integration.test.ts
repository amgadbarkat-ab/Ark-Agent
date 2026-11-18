import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import type { AccountStore, Entitlement } from "../src/accounts/store";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import {
  trialCheckIns,
  trialCodes,
  trialRoster,
  trialState,
} from "../src/db/schema";
import { guardProfiles, withTrialEntitlement } from "../src/trial/guard";
import { trialCheckInRoutes } from "../src/trial/routes";
import {
  CREATE_BLOCKED_MESSAGE,
  createTrialService,
  TrialCreateBlockedError,
  TrialRefusedError,
} from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const blackArk = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");

async function clear() {
  await database.delete(trialState);
  await database.delete(trialRoster);
  await database.delete(trialCodes);
  await database.delete(trialCheckIns);
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await database.$client.close();
});

const roster = [
  {
    key: "front-desk",
    name: "Front Desk",
    title: "Front Desk",
    roleDescription: "Answers enquiries.",
    instructions: "Draft every reply for approval.",
  },
  {
    key: "accountant",
    name: "Accountant",
    title: "Accounting",
    roleDescription: "Prepares invoice drafts.",
    instructions: "Never send anything yourself.",
  },
];

function profileFile(
  over: Record<string, unknown> = {},
  key: KeyObject = blackArk.privateKey,
) {
  const profile = readProfile({
    v: 1,
    customer: { id: "demo-shop", name: "Demo Shop" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2026-12-16T00:00:00Z",
    plan: "team",
    createBlocked: true,
    checkInUrl: "https://blackark.example/api/trial-checkins",
    roster,
    ...over,
  });
  const encoded = encodeBase64Url(JSON.stringify(profile));
  return JSON.stringify({
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(key, encoded),
  });
}

let nonce = 0;
function code(
  over: Record<string, unknown>,
  key: KeyObject = blackArk.privateKey,
) {
  nonce += 1;
  const payload = encodeBase64Url(
    JSON.stringify({
      v: 1,
      customer: "demo-shop",
      nonce: `nonce-${nonce}-abcdef`,
      issuedAt: "2026-11-20T10:00:00Z",
      ...over,
    }),
  );
  return `${CODE_PREFIX}${payload}.${signText(key, payload)}`;
}

function harness(start = "2026-11-17T09:00:00Z") {
  let clock = new Date(start);
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const service = createTrialService(database, {
    keys: [blackArk.publicKey],
    version: "0.1.37",
    now: () => clock,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
  return {
    service,
    sent,
    setClock: (iso: string) => {
      clock = new Date(iso);
    },
  };
}

const internal: Entitlement = {
  tenantId: "t",
  planId: "internal",
  planName: "Internal",
  subscriptionStatus: "active",
  maxActiveBots: null,
  canRun: true,
};

describe("a customer trial on this install (#109)", () => {
  test("no trial changes nothing", async () => {
    const { service } = harness();
    expect(await service.current()).toBeNull();
    expect(await service.createBlocked()).toBe(false);
    expect(await service.entitlement(internal)).toEqual(internal);
  });

  test("a build with no key, or a profile signed by anyone else, is refused", async () => {
    const keyless = createTrialService(database, { keys: [], version: "x" });
    await expect(keyless.importProfile(profileFile())).rejects.toThrow(
      /no BlackArk key yet/,
    );
    const { service } = harness();
    await expect(
      service.importProfile(profileFile({}, stranger.privateKey)),
    ).rejects.toThrow("This trial profile is not signed by BlackArk.");
    await expect(service.importProfile("{}")).rejects.toThrow(
      TrialRefusedError,
    );
    expect(await service.current()).toBeNull();
  });

  test("import once; the same file again, an older one, or another customer's change nothing", async () => {
    const { service } = harness();
    const first = await service.importProfile(profileFile());
    expect(first.changed).toBe(true);
    expect(first.trial).toMatchObject({
      customerName: "Demo Shop",
      status: "trial",
      lengthDays: 30,
      daysLeft: 29,
      planName: "Ark Team",
      createBlocked: true,
      rosterSize: 2,
      checkInHost: "blackark.example",
    });
    expect((await service.importProfile(profileFile())).changed).toBe(false);
    await expect(
      service.importProfile(profileFile({ issuedAt: "2026-11-01T00:00:00Z" })),
    ).rejects.toThrow("older than the one already imported");
    await expect(
      service.importProfile(
        profileFile({ customer: { id: "demo-clinic", name: "Demo Clinic" } }),
      ),
    ).rejects.toThrow("already has the trial for Demo Shop");
  });

  test("the plan is the profile's while it runs; from the end on nothing runs, and turning the clock back does not undo it", async () => {
    const { service, setClock } = harness();
    await service.importProfile(profileFile());
    expect(await service.entitlement(internal)).toMatchObject({
      planId: "team",
      maxActiveBots: 15,
      canRun: true,
    });
    setClock("2026-12-16T00:00:01Z");
    const ended = await service.entitlement(internal);
    expect(ended).toMatchObject({ canRun: false, blockedCode: "trial_ended" });
    expect(ended.blockedReason).toBe(
      "Your 30-day trial ended on 2026-12-16. Your conversations and settings are kept. Enter an unlock code in Settings, then Plan, to continue.",
    );
    setClock("2026-11-20T00:00:00Z");
    expect((await service.entitlement(internal)).canRun).toBe(false);
    expect((await service.current())?.status).toBe("ended");
  });

  test("the account summary carries the trial's plan and end", async () => {
    const { service } = harness();
    await service.importProfile(profileFile());
    const accounts = {
      entitlementFor: async () => internal,
      summaryFor: async () => ({
        ...internal,
        tenantName: "Internal",
        activeBots: 0,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        provider: "manual",
      }),
    } as unknown as AccountStore;
    const summary = await withTrialEntitlement(accounts, {
      entitlement: service.entitlement,
      trialCurrent: service.current,
    }).summaryFor("u");
    expect(summary).toMatchObject({
      planId: "team",
      subscriptionStatus: "trialing",
      currentPeriodEnd: "2026-12-16T00:00:00.000Z",
    });
  });

  test("under the block every create and duplicate is refused, the roster is still set up once, and a hidden example stays hidden", async () => {
    const { service } = harness();
    await service.importProfile(profileFile());
    const made: string[] = [];
    const hidden: [string, boolean][] = [];
    const raw = {
      create: async (_actor: unknown, input: { name: string }) => {
        made.push(input.name);
        return { id: `agent-${input.name}` };
      },
      duplicate: async () => ({ id: "copy" }),
      setHidden: async (_actor: unknown, id: string, value: boolean) => {
        hidden.push([id, value]);
      },
    } as unknown as AgentProfileStore;
    const guarded = guardProfiles(raw, service);
    const actor = { id: "u", role: "admin" as const };
    const input = {
      name: "Extra",
      title: "x",
      roleDescription: "x",
      visibility: "private" as const,
    };
    await expect(guarded.create(actor, input)).rejects.toThrow(
      TrialCreateBlockedError,
    );
    await expect(guarded.create(actor, input)).rejects.toThrow(
      CREATE_BLOCKED_MESSAGE,
    );
    await expect(guarded.duplicate(actor, "x")).rejects.toThrow(
      TrialCreateBlockedError,
    );
    const seed = () =>
      service.seed(async (entry) =>
        guarded.create(actor, { ...input, name: entry.name }).then((p) => ({
          agentId: p.id,
        })),
      );
    const [a, b] = await Promise.all([seed(), seed()]);
    expect(a + b).toBe(2);
    expect(made).toEqual(["Front Desk", "Accountant"]);
    expect(await seed()).toBe(0);
    await expect(
      guarded.setHidden(actor, "general-assistant", false),
    ).rejects.toThrow(TrialCreateBlockedError);
    await guarded.setHidden(actor, "agent-Front Desk", false);
    expect(hidden).toEqual([["agent-Front Desk", false]]);
  });

  test("unlock codes: extend, used once, for this customer only; end now; paid lifts the block and the end", async () => {
    const { service, setClock } = harness();
    await service.importProfile(profileFile());
    const later = code({ action: "extend", until: "2027-01-31T00:00:00Z" });
    const extended = await service.applyCode(later);
    expect(extended.trial.endsAt).toBe("2027-01-31T00:00:00.000Z");
    await expect(service.applyCode(later)).rejects.toThrow("already used");
    await expect(
      service.applyCode(code({ action: "end", customer: "demo-clinic" })),
    ).rejects.toThrow("for another customer");
    await expect(
      service.applyCode(code({ action: "end" }, stranger.privateKey)),
    ).rejects.toThrow("not signed by BlackArk");
    await expect(service.applyCode("ARK1-nonsense")).rejects.toThrow(
      "not an unlock code",
    );
    const ended = await service.applyCode(code({ action: "end" }));
    expect(ended.trial.status).toBe("ended");
    // A profile imported again does not undo an end a code set.
    await service.importProfile(profileFile());
    expect((await service.current())?.status).toBe("ended");
    const paid = await service.applyCode(code({ action: "paid" }));
    expect(paid.trial).toMatchObject({ status: "paid", createBlocked: false });
    setClock("2028-01-01T00:00:00Z");
    expect(await service.entitlement(internal)).toEqual(internal);
    expect(await service.createBlocked()).toBe(false);
    await expect(service.applyCode(code({ action: "end" }))).rejects.toThrow(
      "already converted to paid",
    );
  });

  test("a check-in says status and days left, never names, and BlackArk's server keeps one row per install", async () => {
    const { service, sent } = harness();
    await service.importProfile(profileFile());
    expect(await service.checkIn()).toBe("sent");
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body ?? {};
    expect(sent[0]?.url).toBe("https://blackark.example/api/trial-checkins");
    expect(Object.keys(body).sort()).toEqual([
      "customerId",
      "daysLeft",
      "employees",
      "endsAt",
      "installId",
      "proof",
      "status",
      "version",
    ]);
    // Only the signed file BlackArk made rides along; no field holds anything the customer wrote.
    const { proof, ...plain } = body as { proof: Record<string, string> };
    expect(Object.keys(proof).sort()).toEqual(["profile", "signature"]);
    expect(JSON.stringify(plain)).not.toContain("Demo Shop");
    expect(JSON.stringify(plain)).not.toContain("Front Desk");

    const receiver = trialCheckInRoutes(database);
    const post = (payload: unknown) =>
      receiver.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect((await post(body)).status).toBe(204);
    expect((await post({ ...body, daysLeft: 28 })).status).toBe(204);
    expect((await post({ ...body, note: "hello" })).status).toBe(400);
    const rows = await database.select().from(trialCheckIns);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.daysLeft).toBe(28);
  });

  test("from v0.1.49 a check-in also carries counts, and still nothing anyone wrote (#149)", async () => {
    const sent: { body: Record<string, unknown> }[] = [];
    const service = createTrialService(database, {
      keys: [blackArk.publicKey],
      version: "0.1.49",
      now: () => new Date("2026-11-17T09:00:00Z"),
      counts: async () => ({
        people: 5,
        activePeople7d: 3,
        conversations7d: 41,
        phoneLine: true,
        os: "windows",
      }),
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await service.importProfile(profileFile());
    expect(await service.checkIn()).toBe("sent");
    const body = sent[0]?.body ?? {};
    expect(body).toMatchObject({
      people: 5,
      activePeople7d: 3,
      conversations7d: 41,
      phoneLine: true,
      os: "windows",
    });
    const { proof: _proof, ...plain } = body;
    expect(JSON.stringify(plain)).not.toContain("Demo Shop");
    // BlackArk's own receiver accepts the counts (and keeps none of them).
    const receiver = trialCheckInRoutes(database);
    const answer = await receiver.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(answer.status).toBe(204);
  });

  test("a check-in whose counts fail goes without them", async () => {
    const sent: { body: Record<string, unknown> }[] = [];
    const service = createTrialService(database, {
      keys: [blackArk.publicKey],
      version: "0.1.49",
      now: () => new Date("2026-11-17T09:00:00Z"),
      counts: async () => {
        throw new Error("database busy");
      },
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await service.importProfile(profileFile());
    expect(await service.checkIn()).toBe("sent");
    expect(sent[0]?.body).not.toHaveProperty("people");
  });

  test("no check-in address, no check-in", async () => {
    const { service, sent } = harness();
    await service.importProfile(profileFile({ checkInUrl: undefined }));
    expect(await service.checkIn()).toBe("none");
    expect(sent).toHaveLength(0);
  });
});
