import { describe, expect, test } from "bun:test";
import { joinCodeFor, signJoinToken, verifyJoinToken } from "../src/tokens";

const secret = "s".repeat(40);
const now = 1_700_000_000_000;

describe("join tokens", () => {
  test("round-trips the scope they were issued for", () => {
    const scope = { kind: "thread", threadId: "t1", userId: "ann" } as const;
    const token = signJoinToken(secret, scope, 60, now);
    expect(verifyJoinToken(secret, token, now + 1000)).toEqual(scope);
  });

  test("rejects expiry, a wrong secret, tampering and garbage", () => {
    const token = signJoinToken(
      secret,
      { kind: "meta", userId: "ann" },
      60,
      now,
    );
    expect(verifyJoinToken(secret, token, now + 61_000)).toBeNull();
    expect(verifyJoinToken("x".repeat(40), token, now)).toBeNull();
    const [body, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        s: { kind: "meta", userId: "bob" },
        exp: 9_999_999_999,
      }),
    ).toString("base64url");
    expect(verifyJoinToken(secret, `${forged}.${signature}`, now)).toBeNull();
    expect(verifyJoinToken(secret, `${body}.`, now)).toBeNull();
    expect(verifyJoinToken(secret, "garbage", now)).toBeNull();
    expect(verifyJoinToken(secret, "", now)).toBeNull();
  });

  test("join codes are stable per person and differ between people", () => {
    expect(joinCodeFor(secret, "ann")).toBe(joinCodeFor(secret, "ann"));
    expect(joinCodeFor(secret, "ann")).not.toBe(joinCodeFor(secret, "bob"));
    expect(joinCodeFor(secret, "ann")).toMatch(/^[0-9a-f]{16}$/);
  });
});
