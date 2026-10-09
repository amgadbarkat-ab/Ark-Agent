import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { iconProblem } from "../mobile/scripts/ios-config";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts));
const text = (...parts: string[]) => read(...parts).toString("utf8");

/** Width, height and PNG colour type, read from the file's own header. */
function png(...parts: string[]) {
  const bytes = read(...parts);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    colourType: bytes[25],
  };
}

const tokens = JSON.parse(text("brand", "brand-tokens.json"));
const EMBER: string = tokens.color.dark_mode.ember;
const INK: string = tokens.color.dark_mode.text_on_ember;

describe("the brand pack", () => {
  test("is the company's v3 identity, unaltered in its colours", () => {
    expect(tokens.name).toBe("BlackArk Visual Identity v3 (Ember)");
    expect(EMBER).toBe("#FF7A1A");
    expect(INK).toBe("#1A0B03");
  });

  test("the css tokens carry the same colours as the json", () => {
    const css = text("brand", "brand-tokens.css").toLowerCase();
    expect(css).toContain(`--ba-ember:${EMBER.toLowerCase()}`);
    expect(css).toContain(`--ba-text-on-ember:${INK.toLowerCase()}`);
  });

  test("the logos and the fonts, with the font licence, are all here", () => {
    for (const file of [
      "logo-lockup-on-dark.png",
      "logo-lockup-on-light.png",
      "logo-lockup-transparent.png",
      "logo-icon-bars.png",
      "logo-icon-bars.svg",
    ]) {
      expect(existsSync(join(root, "brand", "logos", file))).toBe(true);
    }
    for (const file of [
      "Geist-Variable.woff2",
      "GeistMono-Regular.woff2",
      "GeistMono-Medium.woff2",
      "LICENSE.txt",
    ]) {
      expect(existsSync(join(root, "brand", "fonts", file))).toBe(true);
    }
    // A font shipped without its licence is not ours to ship.
    expect(text("brand", "fonts", "LICENSE.txt")).toContain(
      "SIL OPEN FONT LICENSE",
    );
  });

  test("the mark is drawn in the company's two colours and nothing else", () => {
    const mark = text("brand", "mark.svg");
    const fills = [...mark.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) =>
      m[1].toUpperCase(),
    );
    expect(new Set(fills)).toEqual(new Set([EMBER, INK]));
  });

  test("the desktop's welcome screen draws the same tile", () => {
    const welcome = text("desktop", "src", "Welcome.tsx");
    const rects = [
      ...text("brand", "mark.svg").matchAll(/<rect ([^>]*?)\/>/g),
    ].map((m) => m[1].trim().replace(/\s+/g, " "));
    expect(rects.length).toBe(4);
    for (const rect of rects) {
      // JSX writes the same attributes on one line, in the same order.
      expect(welcome.replace(/\s+/g, " ")).toContain(`<rect ${rect} />`);
    }
  });
});

describe("the icons", () => {
  test("the web app's 192 and home-screen icons are the company's own files", () => {
    expect(
      read("app", "public", "icons", "icon-192.png").equals(
        read("brand", "official", "favicon-192.png"),
      ),
    ).toBe(true);
    expect(
      read("app", "public", "icons", "apple-touch-icon.png").equals(
        read("brand", "official", "apple-touch-icon.png"),
      ),
    ).toBe(true);
  });

  test("the web app has every size its manifest promises", () => {
    expect(png("app", "public", "icons", "icon-512.png")).toMatchObject({
      width: 512,
      height: 512,
    });
    expect(
      png("app", "public", "icons", "icon-maskable-512.png"),
    ).toMatchObject({ width: 512, height: 512 });
    const manifest = JSON.parse(text("app", "public", "manifest.webmanifest"));
    expect(manifest.name).toBe("Ark Agent");
    for (const icon of manifest.icons) {
      expect(existsSync(join(root, "app", "public", icon.src))).toBe(true);
    }
  });

  test("the maskable icon is full-bleed, so a launcher's mask never shows a corner", () => {
    // Colour type 2 is RGB with no alpha channel: every pixel is painted.
    expect(
      png("app", "public", "icons", "icon-maskable-512.png").colourType,
    ).toBe(2);
    expect(text("app", "public", "icons", "icon-maskable.svg")).not.toMatch(
      /rx="28"/,
    );
  });

  test("the iOS App Store icon passes the checks the build makes", () => {
    expect(
      iconProblem(read("mobile", "ios", "brand", "AppIcon-1024.png")),
    ).toBeNull();
  });

  test("the Android adaptive icon is the company's ember with the bars on it", () => {
    const res = ["mobile", "android", "app", "src", "main", "res"];
    const background = text(...res, "values", "ic_launcher_background.xml");
    expect(background).toContain(EMBER);
    const foreground = text(...res, "drawable", "ic_launcher_foreground.xml");
    expect(foreground).toContain(`android:fillColor="${INK}"`);
    // Three bars.
    expect(foreground.match(/<path/g)?.length).toBe(3);
    const adaptive = text(...res, "mipmap-anydpi-v26", "ic_launcher.xml");
    expect(adaptive).toContain("@color/ic_launcher_background");
    expect(adaptive).toContain("@drawable/ic_launcher_foreground");
    // Android 13 themed icons.
    expect(adaptive).toContain("<monochrome");
  });

  test("the Android bars stay inside the circle every launcher mask shows", () => {
    const foreground = text(
      "mobile",
      "android",
      "app",
      "src",
      "main",
      "res",
      "drawable",
      "ic_launcher_foreground.xml",
    );
    // The canvas is 108 and the part always shown is a circle of 66 about its middle (radius 33).
    const corners: Array<[number, number]> = [];
    for (const path of foreground.matchAll(/pathData="([^"]+)"/g)) {
      // The paths are made of M, H, V and A with absolute coordinates; follow the pen.
      let x = 0;
      let y = 0;
      for (const [, command, args] of path[1].matchAll(
        /([MHVAZ])([^MHVAZ]*)/g,
      )) {
        const n = args
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        if (command === "M") [x, y] = n as [number, number];
        if (command === "H") x = n[0];
        if (command === "V") y = n[0];
        if (command === "A") [x, y] = [n[5], n[6]];
        corners.push([x, y]);
      }
    }
    expect(corners.length).toBeGreaterThan(0);
    for (const [x, y] of corners) {
      expect(Math.hypot(x - 54, y - 54)).toBeLessThanOrEqual(33);
    }
  });

  test("the desktop has its master and the sizes made from it", () => {
    expect(png("desktop", "src-tauri", "icons", "icon.png")).toMatchObject({
      width: 1024,
      height: 1024,
      colourType: 6,
    });
    expect(png("desktop", "src-tauri", "icons", "64x64.png")).toMatchObject({
      width: 64,
      height: 64,
    });
    const config = JSON.parse(text("desktop", "src-tauri", "tauri.conf.json"));
    expect(config.productName).toBe("Ark Agent");
    for (const icon of config.bundle.icon) {
      expect(existsSync(join(root, "desktop", "src-tauri", icon))).toBe(true);
    }
  });
});
