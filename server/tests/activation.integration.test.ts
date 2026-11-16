import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
} from "../../shared/trial";
import { signText } from "../../shared/trial-sign";
import type { Entitlement } from "../src/accounts/store";
import { createDatabase } from "../src/db/client";
import {
  activationState,
  trialCheckIns,
  trialCodes,
  trialRoster,
  trialState,
} from "../src/db/schema";
import {
  createActivationService,
  NOT_ACTIVATED_MESSAGE,
} from "../src/trial/activation";
import { createTrialService, TrialRefusedError } from "../src/trial/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const trialKey = generateKeyPairSync("ed25519");
const licenseKey = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");

async function clear() {
  await database.delete(activationState);
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

let nonce = 0;
function signed(payload: Record<string, unknown>, key: KeyObject) {
  nonce += 1;
  const encoded = encodeBase64Url(
    JSON.stringify({
      v: 1,
      customer: "demo-shop",
      nonce: `nonce-${nonce}-abcdef`,
      issuedAt: "2026-11-17T08:00:00Z",
      ...payload,
    }),
  );
  return `${CODE_PREFIX}${encoded}.${signText(key, encoded)}`;
}

const trialCode = (
  over: Record<string, unknown> = {},
  key = trialKey.privateKey,
) =>
  signed(
    { action: "trial", plan: "team", until: "2026-12-17T00:00:00Z", ...over },
    key,
  );

const license = (
  over: Record<string, unknown> = {},
  key = licenseKey.privateKey,
) =>
  signed(
    {
      action: "license",
      plan: "team",
      seats: 1,
      validUntil: "2026-12-24T00:00:00Z",
      ...over,
    },
    key,
  );

function profileFile(over: Record<string, unknown> = {}) {
  const profile = readProfile({
    v: 1,
    customer: { id: "demo-shop", name: "Demo Shop" },
    issuedAt: "2026-11-15T10:00:00Z",
    startsAt: "2026-11-16T00:00:00Z",
    endsAt: "2026-12-16T00:00:00Z",
    plan: "team",
    createBlocked: true,
    roster: [
      {
        key: "front-desk",
        name: "Front Desk",
        title: "Front Desk",
        roleDescription: "Answers enquiries.",
        instructions: "Draft every reply for approval.",
      },
    ],
    ...over,
  });
  const encoded = encodeBase64Url(JSON.stringify(profile));
  return JSON.stringify({
    format: PROFILE_FORMAT,
    profile: encoded,
    signature: signText(trialKey.privateKey, encoded),
  });
}

function harness(required = true, start = "2026-11-17T09:00:00Z") {
  let clock = new Date(start);
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  let answer: () => Response = () => Response.json({});
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return answer();
  }) as unknown as typeof fetch;
  const trial = createTrialService(database, {
    keys: [trialKey.publicKey],
    version: "0.1.42",
    now: () => clock,
    fetch: fakeFetch,
  });
  const activation = createActivationService(database, {
    required,
    trialKeys: [trialKey.publicKey],
    licenseKeys: [licenseKey.publicKey],
    trial,
    version: "0.1.42",
    now: () => clock,
    fetch: fakeFetch,
  });
  return {
    trial,
    activation,
    sent,
    answerWith: (make: () => Response) => {
      answer = make;
    },
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

describe("activation (#109, v0.1.42)", () => {
  test("where it is not required (hosted, dev, CI), nothing changes", async () => {
    const { activation } = harness(false);
    const view = await activation.current();
    expect(view).toMatchObject({
      required: false,
      allowed: true,
      state: "none",
    });
    expect(await activation.entitlement(internal)).toEqual(internal);
    expect(await activation.createBlocked()).toBe(false);
  });

  test("on a desktop install, nothing runs without a code, a key or the setup file", async () => {
    const { activation } = harness();
    expect(await activation.current()).toMatchObject({
      required: true,
      allowed: false,
      state: "none",
    });
    expect(await activation.entitlement(internal)).toMatchObject({
      canRun: false,
      blockedCode: "not_activated",
      blockedReason: NOT_ACTIVATED_MESSAGE,
    });
  });

  test("a trial activation code opens it until its fixed end, then not", async () => {
    const { activation, setClock } = harness();
    const applied = await activation.apply(trialCode());
    expect(applied).toMatchObject({ kind: "trial", changed: true });
    expect(applied.activation).toMatchObject({
      allowed: true,
      state: "trial",
      source: "trial-code",
      customerId: "demo-shop",
      planId: "team",
      until: "2026-12-17T00:00:00.000Z",
      daysLeft: 30,
    });
    expect(await activation.entitlement(internal)).toMatchObject({
      canRun: true,
      planId: "team",
      subscriptionStatus: "trialing",
    });
    setClock("2026-12-17T00:00:01Z");
    expect(await activation.current()).toMatchObject({
      allowed: false,
      state: "ended",
    });
    expect(await activation.entitlement(internal)).toMatchObject({
      canRun: false,
      blockedCode: "trial_ended",
    });
  });

  test("turning the clock back does not bring an ended trial back", async () => {
    const { activation, setClock } = harness();
    await activation.apply(trialCode());
    setClock("2026-12-18T09:00:00Z");
    expect((await activation.current()).state).toBe("ended");
    setClock("2026-11-20T09:00:00Z");
    expect((await activation.current()).state).toBe("ended");
  });

  test("a code signed by anyone else, or for the wrong key, is refused", async () => {
    const { activation } = harness();
    await expect(
      activation.apply(trialCode({}, stranger.privateKey)),
    ).rejects.toThrow("not signed by BlackArk");
    // A licence key signed with the trial key is not a licence key.
    await expect(
      activation.apply(license({}, trialKey.privateKey)),
    ).rejects.toThrow("not signed by BlackArk");
    await expect(activation.apply("ARK1-nonsense")).rejects.toThrow(
      TrialRefusedError,
    );
    expect((await activation.current()).state).toBe("none");
  });

  test("an already ended code or key is refused, with the day", async () => {
    const { activation } = harness();
    await expect(
      activation.apply(trialCode({ until: "2026-11-10T00:00:00Z" })),
    ).rejects.toThrow("ended on 2026-11-10");
    await expect(
      activation.apply(license({ validUntil: "2026-11-10T00:00:00Z" })),
    ).rejects.toThrow("expired on 2026-11-10");
  });

  test("a paid licence key opens it, lifts the trial's block, and expires after its grace", async () => {
    const { activation, trial, setClock } = harness();
    await trial.importProfile(profileFile());
    expect(await activation.createBlocked()).toBe(true);
    const applied = await activation.apply(
      license({ addons: ["phone"], seats: 3 }),
    );
    expect(applied.activation).toMatchObject({
      state: "paid",
      source: "license",
      customerName: "Demo Shop",
      seats: 3,
      addons: ["phone"],
    });
    expect(await activation.createBlocked()).toBe(false);
    expect(await activation.addonEnabled("phone")).toBe(true);
    expect(await activation.entitlement(internal)).toMatchObject({
      canRun: true,
      subscriptionStatus: "active",
      planId: "team",
    });
    setClock("2026-12-24T00:00:01Z");
    expect(await activation.current()).toMatchObject({
      allowed: false,
      state: "expired",
    });
    expect(await activation.entitlement(internal)).toMatchObject({
      canRun: false,
      blockedCode: "license_expired",
    });
    expect(await activation.addonEnabled("phone")).toBe(false);
  });

  test("the same licence key typed again changes nothing; a shorter one is refused", async () => {
    const { activation } = harness();
    const key = license();
    expect((await activation.apply(key)).changed).toBe(true);
    expect((await activation.apply(key)).changed).toBe(false);
    await expect(
      activation.apply(license({ validUntil: "2026-12-20T00:00:00Z" })),
    ).rejects.toThrow("lasts as long or longer");
    await expect(activation.apply(trialCode())).rejects.toThrow(
      "already has a paid licence",
    );
  });

  test("a code for another customer than this computer's is refused", async () => {
    const { activation, trial } = harness();
    await trial.importProfile(profileFile());
    await expect(
      activation.apply(license({ customer: "other-shop" })),
    ).rejects.toThrow("another customer");
  });

  test("the trial setup file counts as activation, and its unlock codes go through the same box", async () => {
    const { activation, trial } = harness();
    await trial.importProfile(profileFile());
    expect(await activation.current()).toMatchObject({
      allowed: true,
      state: "trial",
      source: "trial-profile",
      customerName: "Demo Shop",
    });
    const paid = await activation.apply(
      signed({ action: "paid" }, trialKey.privateKey),
    );
    expect(paid.kind).toBe("paid");
    expect(paid.activation).toMatchObject({ state: "paid", until: null });
  });

  test("an ended setup-file trial blocks, until a licence key arrives", async () => {
    const { activation, trial, setClock } = harness();
    await trial.importProfile(profileFile());
    setClock("2026-12-16T00:00:01Z");
    expect(await activation.current()).toMatchObject({
      allowed: false,
      state: "ended",
    });
    expect((await activation.entitlement(internal)).canRun).toBe(false);
    await activation.apply(license());
    expect((await activation.current()).state).toBe("paid");
    expect((await activation.entitlement(internal)).canRun).toBe(true);
  });

  test("renewal sends ids only, and takes a renewed key", async () => {
    const { activation, sent, answerWith, setClock } = harness();
    await activation.apply(
      license({ renewUrl: "https://blackark.example/checkin/renew/" }),
    );
    const renewed = license({
      issuedAt: "2026-12-20T08:00:00Z",
      validUntil: "2027-01-24T00:00:00Z",
      renewUrl: "https://blackark.example/checkin/renew/",
    });
    answerWith(() => Response.json({ key: renewed }));
    setClock("2026-12-20T09:00:00Z");
    expect(await activation.renew()).toBe("renewed");
    expect(Object.keys(sent[0]?.body ?? {}).sort()).toEqual([
      "customerId",
      "installId",
      "nonce",
      "validUntil",
      "version",
    ]);
    expect(await activation.current()).toMatchObject({
      until: "2027-01-24T00:00:00.000Z",
      renewHost: "blackark.example",
      lastRenewError: null,
    });
    // No newer key: nothing changes, and that is not an error.
    answerWith(() => Response.json({}));
    expect(await activation.renew()).toBe("unchanged");
    // A forged key in the answer is not taken.
    answerWith(() =>
      Response.json({
        key: license(
          { validUntil: "2028-01-01T00:00:00Z" },
          stranger.privateKey,
        ),
      }),
    );
    expect(await activation.renew()).toBe("failed");
    expect((await activation.current()).until).toBe("2027-01-24T00:00:00.000Z");
  });

  test("a trial code's add-on switches it on while the trial runs", async () => {
    const { activation, setClock } = harness();
    await activation.apply(trialCode({ addons: ["phone"] }));
    expect(await activation.addonEnabled("phone")).toBe(true);
    setClock("2026-12-18T00:00:00Z");
    expect(await activation.addonEnabled("phone")).toBe(false);
  });
});
