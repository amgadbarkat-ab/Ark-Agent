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

  test("the still tile in the desktop and in the web app is the same drawing", () => {
    /** The attributes of every rect in some markup, each as a sorted "name=value" list. */
    const rects = (markup: string) =>
      [...markup.matchAll(/<rect\b([^>]*?)\/?>/g)].map((match) =>
        [...match[1].matchAll(/([a-zA-Z-]+)=["{]+([^"}]*)["}]+/g)]
          .map((attribute) => `${attribute[1]}=${attribute[2]}`)
          .sort()
          .join(" "),
      );
    const mark = rects(text("brand", "mark.svg"));
    expect(mark.length).toBe(4);
    for (const file of [
      ["desktop", "src", "ParticleMark.tsx"],
      ["app", "src", "components", "brand", "particle-mark.tsx"],
    ]) {
      const drawn = rects(text(...file));
      for (const rect of mark) expect(drawn).toContain(rect);
    }
  });
});

describe("the icons", () => {
  test("the web app has every size its manifest promises", () => {
    expect(png("app", "public", "icons", "icon-512.png")).toMatchObject({
      width: 512,
      height: 512,
    });
    expect(png("app", "public", "icons", "icon-192.png")).toMatchObject({
      width: 192,
      height: 192,
    });
    expect(png("app", "public", "icons", "apple-touch-icon.png")).toMatchObject(
      { width: 180, height: 180 },
    );
    expect(
      png("app", "public", "icons", "icon-maskable-512.png"),
    ).toMatchObject({ width: 512, height: 512 });
    const manifest = JSON.parse(text("app", "public", "manifest.webmanifest"));
    expect(manifest.name).toBe("ArkAgent");
    for (const icon of manifest.icons) {
      expect(existsSync(join(root, "app", "public", icon.src))).toBe(true);
    }
  });

  test("the app draws the character's icon, which is the one the owner supplied", () => {
    const icon = read("app", "public", "brand", "arkagent-icon.jpg");
    expect(icon[0] === 0xff && icon[1] === 0xd8).toBe(true);
    const source = read("brand", "arkagent", "icon-source.webp");
    expect(source.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(source.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  test("the maskable icon is full-bleed, so a launcher's mask never shows a corner", () => {
    // Colour type 2 is RGB with no alpha channel: every pixel is painted.
    expect(
      png("app", "public", "icons", "icon-maskable-512.png").colourType,
    ).toBe(2);
    expect(text("app", "public", "icons", "icon-maskable.svg")).not.toContain(
      "clipPath",
    );
  });

  test("the iOS App Store icon passes the checks the build makes", () => {
    expect(
      iconProblem(read("mobile", "ios", "brand", "AppIcon-1024.png")),
    ).toBeNull();
  });

  test("the Android adaptive icon is the character on the picture's own dark", () => {
    const res = ["mobile", "android", "app", "src", "main", "res"];
    const background = text(...res, "values", "ic_launcher_background.xml");
    expect(background).toMatch(/>#[0-9a-f]{6}</);
    expect(
      png(...res, "drawable-xxxhdpi", "ic_launcher_foreground.png"),
    ).toMatchObject({ width: 432, height: 432 });
    const adaptive = text(...res, "mipmap-anydpi-v26", "ic_launcher.xml");
    expect(adaptive).toContain("@color/ic_launcher_background");
    expect(adaptive).toContain("@drawable/ic_launcher_foreground");
    // A picture has no silhouette for Android 13 to tint, so there is no themed layer.
    expect(adaptive).not.toContain("<monochrome");
    expect(
      existsSync(join(root, ...res, "drawable", "ic_launcher_foreground.xml")),
    ).toBe(false);
  });

  test("the characters' crops are the same pictures wherever they are used", () => {
    const isJpeg = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8;
    // WebP is a RIFF file whose form type, at bytes 8 to 11, reads "WEBP". These are the owner's own
    // pictures, kept as supplied.
    for (const original of [
      ["brand", "arkagent", "arkagent-poster.webp"],
      ["brand", "arkteam", "arkteam-roster.webp"],
    ]) {
      const bytes = read(...original);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
    }
    const portrait = read("brand", "arkagent", "portrait.jpg");
    expect(isJpeg(portrait)).toBe(true);
    expect(
      read("app", "public", "brand", "arkagent-portrait.jpg").equals(portrait),
    ).toBe(true);
    expect(
      read("desktop", "src", "assets", "arkagent-portrait.jpg").equals(
        portrait,
      ),
    ).toBe(true);
    const roles = [
      "sales",
      "marketing",
      "accounting",
      "inventory-and-logistics",
      "finance",
      "chief-of-operations",
      "chief-of-staff",
      "front-desk",
    ];
    for (const role of roles) {
      const face = read("brand", "arkteam", "roles", `${role}.jpg`);
      expect(isJpeg(face)).toBe(true);
      expect(
        read("app", "public", "brand", "team", `${role}.jpg`).equals(face),
      ).toBe(true);
    }
    expect(
      read("app", "public", "brand", "team", "faces.jpg").equals(
        read("brand", "arkteam", "team-faces.jpg"),
      ),
    ).toBe(true);
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
    expect(config.productName).toBe("ArkAgent");
    for (const icon of config.bundle.icon) {
      expect(existsSync(join(root, "desktop", "src-tauri", icon))).toBe(true);
    }
  });
});
