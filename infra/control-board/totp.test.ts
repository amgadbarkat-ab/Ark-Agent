import { describe, expect, test } from "bun:test";
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from "./totp";

// RFC 6238 Appendix B, SHA-1: the seed is the ASCII "12345678901234567890".
const SEED = Buffer.from("12345678901234567890");
const SEED_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (RFC 6238)", () => {
  test("base32 of the RFC seed", () => {
    expect(base32Encode(SEED)).toBe(SEED_B32);
    expect(base32Decode(SEED_B32).equals(SEED)).toBe(true);
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq")).toEqual(
      SEED,
    );
  });

  test.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("the 8-digit vector at T=%d is %s", (seconds, code) => {
    expect(totp(SEED_B32, seconds * 1000, 8)).toBe(code);
  });

  test("6 digits is the last 6 of the same number", () => {
    expect(totp(SEED_B32, 59_000)).toBe("287082");
    expect(hotp(SEED, 1)).toBe("287082");
  });

  test("a code from the step before or after is accepted, not two away", () => {
    const now = 1_111_111_111_000;
    expect(verifyTotp(SEED_B32, totp(SEED_B32, now - 30_000), now)).not.toBe(
      null,
    );
    expect(verifyTotp(SEED_B32, totp(SEED_B32, now + 30_000), now)).not.toBe(
      null,
    );
    expect(verifyTotp(SEED_B32, totp(SEED_B32, now - 61_000), now)).toBe(null);
  });

  test("a code already used, or an older one, is refused", () => {
    const now = 1_111_111_111_000;
    const step = verifyTotp(SEED_B32, totp(SEED_B32, now), now);
    expect(step).toBe(37037037);
    expect(verifyTotp(SEED_B32, totp(SEED_B32, now), now, step!)).toBe(null);
    expect(verifyTotp(SEED_B32, totp(SEED_B32, now - 30_000), now, step!)).toBe(
      null,
    );
  });

  test("anything that is not six digits is refused", () => {
    expect(verifyTotp(SEED_B32, "28708", 59_000)).toBe(null);
    expect(verifyTotp(SEED_B32, "abcdef", 59_000)).toBe(null);
    expect(verifyTotp(SEED_B32, " 287082", 59_000)).toBe(null);
  });
});
