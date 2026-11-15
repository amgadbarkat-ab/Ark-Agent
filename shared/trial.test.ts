import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  CODE_PREFIX,
  encodeBase64Url,
  PROFILE_FORMAT,
  readProfile,
  readProfileFile,
  readUnlockCode,
  TrialFormatError,
  trialDaysLeftAt,
  trialLengthDays,
} from "./trial";
import {
  publicKeyFromBase64,
  publicKeyToBase64,
  signedByAny,
  signText,
} from "./trial-sign";

const draft = {
  v: 1,
  customer: { id: "wine24", name: "Wine24" },
  issuedAt: "2026-11-15T10:00:00Z",
  startsAt: "2026-11-16T00:00:00+02:00",
  endsAt: "2026-12-16T00:00:00+02:00",
  plan: "team",
  createBlocked: true,
  roster: [
    {
      key: "front-desk",
      name: "Front Desk",
      title: "Front Desk",
      roleDescription: "Answers enquiries.",
      instructions: "Draft every reply for approval.",
      basedOn: "front-desk",
    },
  ],
};

describe("trial profile", () => {
  test("reads a good draft and normalises its dates", () => {
    const profile = readProfile(draft);
    expect(profile.startsAt).toBe("2026-11-15T22:00:00.000Z");
    expect(profile.roster[0]?.basedOn).toBe("front-desk");
    expect(trialLengthDays(profile.startsAt, profile.endsAt)).toBe(30);
  });

  test("refuses an unknown plan, the internal plan, a repeated key and http check-in", () => {
    expect(() => readProfile({ ...draft, plan: "gold" })).toThrow(
      TrialFormatError,
    );
    expect(() => readProfile({ ...draft, plan: "internal" })).toThrow(
      TrialFormatError,
    );
    expect(() =>
      readProfile({ ...draft, roster: [draft.roster[0], draft.roster[0]] }),
    ).toThrow(TrialFormatError);
    expect(() =>
      readProfile({ ...draft, checkInUrl: "http://example.com/x" }),
    ).toThrow(TrialFormatError);
  });

  test("a paid add-on is on only when the profile names it, and a misspelt one is refused", () => {
    expect(readProfile(draft).addons).toBeUndefined();
    expect(
      readProfile({ ...draft, addons: ["phone", "phone"] }).addons,
    ).toEqual(["phone"]);
    expect(readProfile({ ...draft, addons: [] }).addons).toBeUndefined();
    expect(() => readProfile({ ...draft, addons: ["phones"] })).toThrow(
      TrialFormatError,
    );
    expect(() => readProfile({ ...draft, addons: "phone" })).toThrow(
      TrialFormatError,
    );
  });

  test("a signature covers exactly the signed text", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = publicKeyFromBase64(publicKeyToBase64(publicKey));
    const encoded = encodeBase64Url(JSON.stringify(readProfile(draft)));
    const file = JSON.stringify({
      format: PROFILE_FORMAT,
      profile: encoded,
      signature: signText(privateKey, encoded),
    });
    const read = readProfileFile(file);
    expect(read.profile.customer.id).toBe("wine24");
    expect(signedByAny([key], read.file.profile, read.file.signature)).toBe(
      true,
    );
    const tampered = encodeBase64Url(
      JSON.stringify({ ...readProfile(draft), endsAt: "2027-12-16T00:00:00Z" }),
    );
    expect(signedByAny([key], tampered, read.file.signature)).toBe(false);
    const other = generateKeyPairSync("ed25519").publicKey;
    expect(signedByAny([other], read.file.profile, read.file.signature)).toBe(
      false,
    );
  });

  test("an unlock code reads back, with spaces and line breaks from pasting", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const payload = encodeBase64Url(
      JSON.stringify({
        v: 1,
        customer: "wine24",
        nonce: "abcdefgh1234",
        action: "extend",
        until: "2027-01-10",
        issuedAt: "2026-11-20T10:00:00Z",
      }),
    );
    const code = `${CODE_PREFIX}${payload}.${signText(privateKey, payload)}`;
    const pasted = `${code.slice(0, 40)}\n  ${code.slice(40)}`;
    expect(readUnlockCode(pasted).code.until).toBe("2027-01-10T00:00:00.000Z");
    expect(() => readUnlockCode("hello")).toThrow(TrialFormatError);
  });

  test("days left counts a part day and stops at zero", () => {
    const end = "2026-12-16T00:00:00Z";
    expect(trialDaysLeftAt(end, new Date("2026-12-15T23:00:00Z"))).toBe(1);
    expect(trialDaysLeftAt(end, new Date("2026-12-16T00:00:00Z"))).toBe(0);
  });
});

describe("the key this release trusts (#109)", () => {
  test("is BlackArk's posted key, and reads as an Ed25519 public key", async () => {
    const { TRIAL_PUBLIC_KEYS } = await import("./trial-public-key");
    expect(TRIAL_PUBLIC_KEYS).toEqual([
      "+sUZUOflN+rBn01lZ1gTFr/Q2hL/OqhJqJ1XizQ9+9o=",
    ]);
    for (const key of TRIAL_PUBLIC_KEYS) {
      expect(publicKeyToBase64(publicKeyFromBase64(key))).toBe(key);
    }
  });
});
