import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN, type TestBoard, testBoard } from "./test-helpers";

const BRAND = join(import.meta.dir, "..", "..", "brand");

let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function anonymous(path: string) {
  current = await testBoard();
  return current.board.fetch(new Request(`${ORIGIN}${path}`), "203.0.113.7");
}

describe("the board's brand assets", () => {
  for (const [path, file, type] of [
    ["/favicon.ico", "official/favicon.ico", "image/x-icon"],
    ["/favicon-32.png", "official/favicon-32.png", "image/png"],
    ["/favicon-192.png", "official/favicon-192.png", "image/png"],
    ["/apple-touch-icon.png", "official/apple-touch-icon.png", "image/png"],
    ["/fonts/geist.woff2", "fonts/Geist-Variable.woff2", "font/woff2"],
    ["/fonts/geist-mono.woff2", "fonts/GeistMono-Variable.woff2", "font/woff2"],
  ] as const) {
    test(`${path} is brand/${file}, served by the board before sign-in`, async () => {
      const response = await anonymous(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = new Uint8Array(await response.arrayBuffer());
      expect(Buffer.from(body).equals(readFileSync(join(BRAND, file)))).toBe(
        true,
      );
    });
  }
});

describe("the board's pages, in the company's look", () => {
  test("the sign-in page has blackark.uk's icons and the tile logo, and loads nothing from elsewhere", async () => {
    const response = await anonymous("/login");
    const page = await response.text();
    for (const link of [
      '<link rel="icon" href="/favicon.ico" sizes="any">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
      '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    ])
      expect(page).toContain(link);
    // The tile as brand/mark.svg draws it: ember square, three ascending bars.
    expect(page).toContain(
      '<rect width="160" height="160" rx="28" fill="#FF7A1A"/>',
    );
    expect(page).toContain(
      '<rect x="100" y="34" width="26" height="96" rx="6" fill="#1A0B03"/>',
    );
    const loaded = [...page.matchAll(/<(?:link|script|img)\b[^>]*>/g)]
      .map((m) => m[0].match(/(?:href|src)="([^"]*)"/)?.[1] ?? "")
      .filter(Boolean);
    expect(loaded.length).toBeGreaterThan(4);
    for (const url of loaded) expect(url).toMatch(/^\/[^/]/);
  });

  test("the stylesheet's fonts are the board's own, and the policy lets them load from the board only", async () => {
    const css = await (await anonymous("/board.css")).text();
    const fonts = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) =>
      (m[1] ?? "").replace(/["']/g, ""),
    );
    expect(fonts.sort()).toEqual([
      "/fonts/geist-mono.woff2",
      "/fonts/geist.woff2",
    ]);
    expect(css).toContain("#FF7A1A".toLowerCase());
    const board = current;
    if (!board) throw new Error("no board");
    for (const font of fonts) {
      const response = await board.board.fetch(
        new Request(`${ORIGIN}${font}`),
        "203.0.113.7",
      );
      expect(response.status).toBe(200);
    }
    const policy = (await anonymous("/login")).headers.get(
      "content-security-policy",
    );
    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("data:");
  });

  test("Greek is never drawn half in Geist: Geist has only λ μ π ω ώ Ω, so its faces leave Greek out", async () => {
    const css = await (await anonymous("/board.css")).text();
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
      (m) => m[1] ?? "",
    );
    expect(faces.length).toBe(2);
    for (const face of faces) {
      const range = face.match(/unicode-range:\s*([^;]+);/)?.[1] ?? "";
      const spans = range.split(",").map((part) => {
        const [from = "", to = from] = part
          .trim()
          .replace(/^U\+/i, "")
          .split("-");
        return [parseInt(from, 16), parseInt(to, 16)] as const;
      });
      const covers = (code: number) =>
        spans.some(([from, to]) => code >= from && code <= to);
      expect(covers("A".charCodeAt(0))).toBe(true);
      expect(covers("€".charCodeAt(0))).toBe(true);
      expect(covers("·".charCodeAt(0))).toBe(true);
      for (const greek of "λμπωώΩαά")
        expect(covers(greek.charCodeAt(0))).toBe(false);
      expect(covers(0x1f00)).toBe(false); // Greek Extended
    }
  });
});
