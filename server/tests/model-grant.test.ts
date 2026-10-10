import { describe, expect, test } from "bun:test";
import { sign } from "../src/auth/signed-value";
import {
  GRANT_TTL_MS,
  mintModelGrant,
  readModelGrant,
} from "../src/models/grant";

const KEY = Buffer.alloc(32, 1).toString("base64");
const OTHER = Buffer.alloc(32, 2).toString("base64");
const now = 1_800_000_000_000;
const grant = { actorId: "ann", connectionId: "c-1" };

describe("model grants", () => {
  test("carry exactly who and which connection, and nothing that is a key", () => {
    const token = mintModelGrant(grant, KEY, now);
    expect(readModelGrant(token, KEY, now + 1000)).toEqual(grant);
    expect(
      Buffer.from(token.split(".")[0] as string, "base64url").toString(),
    ).not.toMatch(/key/i);
  });

  test("expire", () => {
    const token = mintModelGrant(grant, KEY, now);
    expect(readModelGrant(token, KEY, now + GRANT_TTL_MS - 1)).toEqual(grant);
    expect(readModelGrant(token, KEY, now + GRANT_TTL_MS)).toBeNull();
  });

  test("cannot be forged, altered, or made with another deployment's key", () => {
    const token = mintModelGrant(grant, KEY, now);
    expect(readModelGrant(token, OTHER, now)).toBeNull();
    const [body, signature] = token.split(".") as [string, string];
    const altered = Buffer.from(
      JSON.stringify({
        actorId: "bob",
        connectionId: "c-1",
        exp: now + 10_000_000,
      }),
    ).toString("base64url");
    expect(readModelGrant(`${altered}.${signature}`, KEY, now)).toBeNull();
    expect(readModelGrant(`${body}.`, KEY, now)).toBeNull();
    for (const junk of [undefined, null, "", 5, {}, "a.b", "garbage"]) {
      expect(readModelGrant(junk, KEY, now)).toBeNull();
    }
  });

  test("a value signed for a different purpose is not a grant", () => {
    const payload = Buffer.from(
      JSON.stringify({ ...grant, exp: now + 60_000 }),
    ).toString("base64url");
    expect(
      readModelGrant(sign(payload, KEY, "openbot:agent-run"), KEY, now),
    ).toBeNull();
  });

  test("with the wrong shape is refused even when correctly signed", () => {
    for (const bad of [
      { actorId: "", connectionId: "c", exp: now + 1 },
      { actorId: "a", connectionId: "", exp: now + 1 },
      { actorId: "a", exp: now + 1 },
      { actorId: "a", connectionId: "c" },
      { actorId: 1, connectionId: "c", exp: now + 1 },
    ]) {
      const payload = Buffer.from(JSON.stringify(bad)).toString("base64url");
      expect(
        readModelGrant(sign(payload, KEY, "ark:model-grant"), KEY, now),
      ).toBeNull();
    }
  });
});
