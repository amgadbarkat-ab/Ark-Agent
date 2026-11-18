/**
 * A QR code, made here (#149): Settings → Phones shows one for the pairing page's address, and the
 * repository takes no new dependency for it.
 *
 * Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes, far more than a pairing
 * address needs). The construction follows ISO/IEC 18004 as Project Nayuki's reference implementation
 * lays it out (MIT): data and padding, Reed-Solomon over GF(256) with 0x11D, interleaved blocks, the
 * function patterns, the zig-zag placement, and the mask with the lowest penalty.
 *
 * Returns rows of booleans (true is dark). Drawing it is the caller's: a quiet zone of four modules
 * around it is needed for a phone to read it.
 */

/** Error-correction codewords per block, level M, versions 1–10. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Number of blocks, level M, versions 1–10. */
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits for level M. */
const LEVEL_M = 0;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}

function multiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** The generator polynomial's coefficients (highest first, leading 1 dropped) for `degree`. */
export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j] as number, root);
      if (j + 1 < degree)
        result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = multiply(root, 2);
  }
  return result;
}

/** The error-correction codewords for `data`. */
export function reedSolomonRemainder(
  data: number[],
  divisor: number[],
): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] = (result[i] as number) ^ multiply(coefficient, factor);
    });
  }
  return result;
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number) =>
  Math.floor(rawDataModules(version) / 8) -
  (ECC_PER_BLOCK[version] as number) * (BLOCKS[version] as number);

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

/** The format bits (15) for level M and a mask, BCH-coded and masked as the standard says. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++)
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The codewords for `bytes` at `version`: data, padding, then the interleaved error correction. */
export function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity * 8 - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11)
    append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((byte, b) => (byte << 1) | b, 0));

  const blocks = BLOCKS[version] as number;
  const eccLength = ECC_PER_BLOCK[version] as number;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = reedSolomonDivisor(eccLength);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(
      k,
      k + shortLength - eccLength + (i < shortBlocks ? 0 : 1),
    );
    k += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    all.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < (all[0] as number[]).length; i++)
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks)
        result.push(block[i] as number);
    });
  return result;
}

export type QrCode = {
  version: number;
  size: number;
  mask: number;
  modules: boolean[][];
};

/** A QR code for `text` (UTF-8), or null when it is too long for version 10. */
export function qrCode(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (
    version <= 10 &&
    bytes.length + (version <= 9 ? 2 : 3) > dataCodewords(version)
  )
    version++;
  if (version > 10) return null;
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const fixed = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, dark: boolean) => {
    (modules[y] as boolean[])[x] = dark;
    (fixed[y] as boolean[])[x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, distance !== 2 && distance !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  positions.forEach((py, i) => {
    positions.forEach((px, j) => {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0)
      )
        return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  const drawFormat = (mask: number) => {
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++)
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }

  const data = codewords(bytes, version);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if ((fixed[y] as boolean[])[x] || index >= data.length * 8) continue;
        (modules[y] as boolean[])[x] = bit(
          data[index >>> 3] as number,
          7 - (index & 7),
        );
        index++;
      }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if ((fixed[y] as boolean[])[x]) continue;
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask];
        if (flip) (modules[y] as boolean[])[x] = !(modules[y] as boolean[])[x];
      }
  };

  let best = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(modules);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return { version, size, mask: best, modules };
}

/** The standard's four penalty rules. Any mask reads; the lowest score reads best. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  const at = (x: number, y: number) => (modules[y] as boolean[])[x] as boolean;
  let score = 0;
  const lines = (read: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && read(i, j) === read(i, j - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      const line = Array.from({ length: size }, (_, j) => read(i, j));
      const pattern = [true, false, true, true, true, false, true];
      for (let j = 0; j + 7 <= size; j++) {
        if (!pattern.every((value, k) => line[j + k] === value)) continue;
        const before = line.slice(Math.max(0, j - 4), j);
        const after = line.slice(j + 7, j + 11);
        if (
          j < 4 ||
          before.every((v) => !v) ||
          j + 11 > size ||
          after.every((v) => !v)
        )
          score += 40;
      }
    }
  };
  lines((i, j) => at(j, i));
  lines((i, j) => at(i, j));
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (at(x, y)) dark++;
      if (x + 1 < size && y + 1 < size) {
        const colour = at(x, y);
        if (
          colour === at(x + 1, y) &&
          colour === at(x, y + 1) &&
          colour === at(x + 1, y + 1)
        )
          score += 3;
      }
    }
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}
