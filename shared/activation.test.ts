import { describe, expect, test } from "bun:test";
import { codeAction, readActivationCode } from "./activation";
import { CODE_PREFIX, encodeBase64Url, TrialFormatError } from "./trial";

const make = (payload: Record<string, unknown>) =>
  `${CODE_PREFIX}${encodeBase64Url(JSON.stringify(payload))}.c2ln`;

const base = {
  v: 1,
  customer: "demo-shop",
  nonce: "abcdefgh12",
  issuedAt: "2026-11-17T08:00:00Z",
  plan: "team",
};

describe("trial activation codes and licence keys (#109, v0.1.42)", () => {
  test("a trial code reads, with its fixed end", () => {
    const { code } = readActivationCode(
      make({ ...base, action: "trial", until: "2026-12-17" }),
    );
    expect(code).toMatchObject({
      action: "trial",
      until: "2026-12-17T00:00:00.000Z",
    });
  });

  test("a licence key reads, with seats, add-ons and an https renewal address", () => {
    const { code } = readActivationCode(
      make({
        ...base,
        action: "license",
        seats: 2,
        validUntil: "2026-12-24",
        addons: ["phone", "phone"],
        renewUrl: "https://blackark.uk/checkin/renew/",
      }),
    );
    expect(code).toMatchObject({
      action: "license",
      seats: 2,
      addons: ["phone"],
      renewUrl: "https://blackark.uk/checkin/renew/",
    });
  });

  test("anything else is refused", () => {
    for (const bad of [
      make({ ...base, action: "trial" }),
      make({ ...base, action: "trial", until: "x" }),
      make({ ...base, action: "trial", plan: "internal", until: "2026-12-17" }),
      make({ ...base, action: "license", validUntil: "2026-12-24" }),
      make({
        ...base,
        action: "license",
        seats: 1,
        validUntil: "2026-12-24",
        renewUrl: "http://plain.example/",
      }),
      make({ ...base, action: "trial", until: "2026-12-17", addons: ["fax"] }),
      make({ ...base, action: "extend", until: "2026-12-17" }),
      "ARK1-",
      "not a code",
    ]) {
      expect(() => readActivationCode(bad)).toThrow(TrialFormatError);
    }
  });

  test("the action is read without checking the rest, so the box can route it", () => {
    expect(codeAction(make({ action: "license" }))).toBe("license");
    expect(codeAction(make({ action: "extend" }))).toBe("extend");
    expect(codeAction("ARK1-%%%")).toBeNull();
    expect(codeAction("hello")).toBeNull();
  });
});
