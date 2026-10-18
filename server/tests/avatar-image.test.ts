import { describe, expect, test } from "bun:test";
import {
  MAX_AVATAR_IMAGE_CHARACTERS,
  parseAvatarImage,
} from "../src/agents/avatar-image";

const url = (kind: string, bytes: number[]) =>
  `data:image/${kind};base64,${Buffer.from(bytes).toString("base64")}`;

describe("parseAvatarImage", () => {
  test("accepts a PNG, a JPEG and a WebP whose bytes say so", () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    for (const value of [
      url("png", [0x89, 0x50, 0x4e, 0x47, 1, 2]),
      url("jpeg", [0xff, 0xd8, 0xff, 0xe0]),
      url("webp", riff),
    ]) {
      expect(parseAvatarImage(value)).toEqual({ ok: true, value });
    }
  });

  test("refuses a label that the bytes do not bear out", () => {
    expect(parseAvatarImage(url("png", [0xff, 0xd8, 0xff])).ok).toBe(false);
    expect(parseAvatarImage(url("jpeg", [60, 115, 118, 103])).ok).toBe(false);
  });

  test("refuses SVG, other schemes, and things that are not strings", () => {
    expect(parseAvatarImage("data:image/svg+xml;base64,PHN2Zz4=").ok).toBe(
      false,
    );
    expect(parseAvatarImage("https://example.com/a.png").ok).toBe(false);
    expect(parseAvatarImage(null).ok).toBe(false);
    expect(parseAvatarImage(42).ok).toBe(false);
  });

  test("refuses a picture too large to carry on every list", () => {
    const big = `data:image/png;base64,${"A".repeat(MAX_AVATAR_IMAGE_CHARACTERS)}`;
    expect(parseAvatarImage(big).ok).toBe(false);
  });
});
