import { describe, expect, test } from "bun:test";
import {
  codewords,
  formatBits,
  qrCode,
  reedSolomonDivisor,
  reedSolomonRemainder,
} from "./qr";

/**
 * Checked against values published with the standard's worked examples (thonky.com's QR tutorial),
 * not against this code: the error correction for "HELLO WORLD" at 1-M, the format strings for level
 * M, and the layout every reader looks for.
 */
describe("QR code", () => {
  test("Reed-Solomon matches the worked HELLO WORLD 1-M example", () => {
    const data = [
      32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17,
    ];
    expect(reedSolomonRemainder(data, reedSolomonDivisor(10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });

  test("format strings for level M match the standard's table", () => {
    const table = [
      "101010000010010",
      "101000100100101",
      "101111001111100",
      "101101101001011",
      "100010111111001",
      "100000011001110",
      "100111110010111",
      "100101010100000",
    ];
    for (let mask = 0; mask < 8; mask++)
      expect(formatBits(mask).toString(2).padStart(15, "0")).toBe(
        table[mask] as string,
      );
  });

  test("byte-mode data is the mode, the count, the bytes, then the pad bytes", () => {
    // "A" at 1-M: 0100 00000001 01000001 0000 → 0x40 0x14 0x10, then EC 11 EC 11 …
    const words = codewords(new TextEncoder().encode("A"), 1);
    expect(words.slice(0, 16)).toEqual([
      0x40, 0x14, 0x10, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11, 0xec, 0x11, 0xec,
    ]);
    expect(words).toHaveLength(26);
  });

  test("a pairing address fits a small code with every fixed pattern in place", () => {
    const code = qrCode("https://link.blackark.uk/_link/pair?code=ABCDEFGH");
    if (!code) throw new Error("no code");
    expect(code.version).toBe(4);
    expect(code.size).toBe(33);
    const m = code.modules;
    const finder = (x: number, y: number) => {
      for (let i = 0; i < 7; i++) {
        expect(m[y]?.[x + i]).toBe(true);
        expect(m[y + 6]?.[x + i]).toBe(true);
        expect(m[y + i]?.[x]).toBe(true);
        expect(m[y + i]?.[x + 6]).toBe(true);
      }
      expect(m[y + 1]?.[x + 1]).toBe(false);
      expect(m[y + 3]?.[x + 3]).toBe(true);
    };
    finder(0, 0);
    finder(code.size - 7, 0);
    finder(0, code.size - 7);
    for (let i = 8; i < code.size - 8; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0);
      expect(m[i]?.[6]).toBe(i % 2 === 0);
    }
    // The dark module, always.
    expect(m[code.size - 8]?.[8]).toBe(true);
    // The format string, read back from beside the top-left finder, is the chosen mask's.
    let read = 0;
    for (let i = 0; i <= 5; i++) read |= (m[i]?.[8] ? 1 : 0) << i;
    read |= (m[7]?.[8] ? 1 : 0) << 6;
    read |= (m[8]?.[8] ? 1 : 0) << 7;
    read |= (m[8]?.[7] ? 1 : 0) << 8;
    for (let i = 9; i < 15; i++) read |= (m[8]?.[14 - i] ? 1 : 0) << i;
    expect(read).toBe(formatBits(code.mask));
  });

  test("version 7 and up carry the version block the standard gives", () => {
    const code = qrCode("x".repeat(120));
    if (!code) throw new Error("no code");
    expect(code.version).toBe(7);
    // Version 7's 18 bits: 000111110010010100.
    let read = 0;
    for (let i = 0; i < 18; i++)
      read |=
        (code.modules[Math.floor(i / 3)]?.[code.size - 11 + (i % 3)] ? 1 : 0) <<
        i;
    expect(read.toString(2).padStart(18, "0")).toBe("000111110010010100");
  });

  test("too long for version 10 is no code rather than a wrong one", () => {
    expect(qrCode("x".repeat(300))).toBeNull();
  });
});
