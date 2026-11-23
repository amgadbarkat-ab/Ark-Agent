import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyDarkTheme,
  parseStoredDarkTheme,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("only the stored dark value enables dark theme", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(true);
  });

  test("persists and applies the selected theme", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];

    applyDarkTheme(true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  test("the boot script reads the same storage key the app writes", () => {
    expect(html).toContain(THEME_STORAGE_KEY);
  });

  test("the boot script runs before the first paint", () => {
    const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>/);

    expect(boot).not.toBeNull();
    expect(boot?.[0]).not.toContain("module");
    expect(boot?.[0]).not.toContain("defer");
  });

  test("the boot script applies the dark class itself", () => {
    expect(html).toContain("documentElement");
    expect(html).toMatch(/classList[\s\S]*dark/);
  });

  test("the document declares a color scheme before the stylesheet arrives", () => {
    expect(html).toContain("colorScheme");
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });
});

/**
 * Amgad, 23 Nov 2026: the app opens in dark, like blackark.uk. The app already did (the boot script
 * above); what the person saw first, the installed app's splash and title bar, was still light.
 */
describe("the first screen is blackark.uk's dark", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(
    readFileSync(
      new URL("../public/manifest.webmanifest", import.meta.url),
      "utf8",
    ),
  ) as { background_color: string; theme_color: string };

  test("someone who never chose a theme gets dark", () => {
    expect(parseStoredDarkTheme(null)).toBe(true);
    expect(html).toContain("let dark = true;");
  });

  test("the browser bar, the splash and the installed app's title bar are blackark.uk's paper", () => {
    expect(html).toContain('<meta name="theme-color" content="#070504" />');
    expect(manifest.background_color).toBe("#070504");
    expect(manifest.theme_color).toBe("#070504");
  });
});
