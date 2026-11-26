import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  checkSite,
  plainName,
  platformOf,
  signedFiles,
} from "./update-manifest";

test("each platform's signed update file, at its release folder on the company site", () => {
  const manifest = buildManifest({
    version: "v0.1.57",
    base: "https://blackark.uk/downloads/releases/",
    now: new Date("2026-11-26T18:00:00Z"),
    files: [
      {
        path: "installers/nsis/ArkAgent_0.1.57_x64-setup.exe",
        signature: "sig-win\n",
      },
      { path: "installers/macos/ArkAgent.app.tar.gz", signature: "sig-mac" },
      {
        path: "installers/appimage/ArkAgent_0.1.57_amd64.AppImage",
        signature: "sig-linux",
      },
      {
        path: "installers/deb/ArkAgent_0.1.57_amd64.deb",
        signature: "sig-deb",
      },
      {
        path: "installers/rpm/ArkAgent-0.1.57-1.x86_64.rpm",
        signature: "sig-rpm",
      },
      { path: "installers/dmg/ArkAgent_0.1.57_aarch64.dmg", signature: "x" },
    ],
  });
  expect(manifest).toEqual({
    version: "0.1.57",
    notes: "ArkAgent v0.1.57",
    pub_date: "2026-11-26T18:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        signature: "sig-win",
        url: "https://blackark.uk/downloads/releases/v0.1.57/ArkAgent_0.1.57_x64-setup.exe",
      },
      "darwin-aarch64": {
        signature: "sig-mac",
        url: "https://blackark.uk/downloads/releases/v0.1.57/ArkAgent.app.tar.gz",
      },
      "linux-x86_64": {
        signature: "sig-linux",
        url: "https://blackark.uk/downloads/releases/v0.1.57/ArkAgent_0.1.57_amd64.AppImage",
      },
      // A .deb or .rpm install looks for its own package first (security review U2).
      "linux-x86_64-deb": {
        signature: "sig-deb",
        url: "https://blackark.uk/downloads/releases/v0.1.57/ArkAgent_0.1.57_amd64.deb",
      },
      "linux-x86_64-rpm": {
        signature: "sig-rpm",
        url: "https://blackark.uk/downloads/releases/v0.1.57/ArkAgent-0.1.57-1.x86_64.rpm",
      },
    },
  });
});

test("a release with no signed update file, an empty signature, or a plain http site is refused", () => {
  expect(() =>
    buildManifest({ version: "v1", base: "https://x.example", files: [] }),
  ).toThrow("No signed update files");
  expect(() =>
    buildManifest({
      version: "v1",
      base: "https://x.example",
      files: [{ path: "a_x64-setup.exe", signature: " " }],
    }),
  ).toThrow("empty signature");
  expect(() =>
    buildManifest({
      version: "v1",
      base: "http://x.example",
      files: [{ path: "a_x64-setup.exe", signature: "s" }],
    }),
  ).toThrow("https");
});

test("every kind of install has its update file; the DMG people download by hand does not", () => {
  expect(platformOf("x/ArkAgent_0.1.57_aarch64.dmg")).toBeNull();
  expect(platformOf("x/build-version.json")).toBeNull();
  expect(platformOf("x/ArkAgent_0.1.57_amd64.deb")).toBe("linux-x86_64-deb");
  expect(platformOf("x/ArkAgent-0.1.57-1.x86_64.rpm")).toBe("linux-x86_64-rpm");
  expect(platformOf("x/ArkAgent_0.1.57_x64-setup.exe")).toBe("windows-x86_64");
});

test("a file name that would need escaping in an address is refused, not guessed at", () => {
  expect(plainName("ArkAgent_0.1.57_x64-setup.exe")).toBe(true);
  expect(plainName("Ark Agent_0.1.57_x64-setup.exe")).toBe(false);
  expect(plainName("../ArkAgent.app.tar.gz")).toBe(false);
  expect(() =>
    buildManifest({
      version: "v1",
      base: "https://x.example",
      files: [{ path: "x/Ark Agent_1_x64-setup.exe", signature: "s" }],
    }),
  ).toThrow("not a plain file name");
});

test("each update file takes its signature from the signing job's folder, and an unsigned one stops the release", () => {
  const root = mkdtempSync(join(tmpdir(), "update-manifest-"));
  const installers = join(root, "installers");
  const signatures = join(root, "signatures");
  mkdirSync(join(installers, "nsis"), { recursive: true });
  mkdirSync(join(installers, "dmg"), { recursive: true });
  mkdirSync(signatures);
  writeFileSync(join(installers, "nsis", "ArkAgent_1_x64-setup.exe"), "exe");
  writeFileSync(join(installers, "dmg", "ArkAgent_1_aarch64.dmg"), "dmg");
  writeFileSync(join(signatures, "ArkAgent_1_x64-setup.exe.sig"), "sig-win");
  expect(signedFiles(installers, signatures)).toEqual([
    {
      path: join(installers, "nsis", "ArkAgent_1_x64-setup.exe"),
      signature: "sig-win",
    },
  ]);
  writeFileSync(join(installers, "ArkAgent_1_amd64.AppImage"), "appimage");
  expect(() => signedFiles(installers, signatures)).toThrow(
    "ArkAgent_1_amd64.AppImage was not signed",
  );
});

test("the site check names whatever an installed app could not fetch", async () => {
  const base = "https://blackark.uk/downloads/releases";
  const manifest = {
    version: "0.1.57",
    platforms: {
      "windows-x86_64": { signature: "s", url: `${base}/v0.1.57/a-setup.exe` },
      "linux-x86_64": { signature: "s", url: `${base}/v0.1.57/a.AppImage` },
    },
  };
  const present = new Set([
    `${base}/update.json`,
    `${base}/v0.1.57/a-setup.exe`,
  ]);
  const get = async (url: string) =>
    present.has(url)
      ? new Response(JSON.stringify(manifest))
      : new Response("", { status: 404 });
  expect(await checkSite(`${base}/`, get)).toEqual([
    `linux-x86_64: ${base}/v0.1.57/a.AppImage does not answer`,
  ]);
  present.add(`${base}/v0.1.57/a.AppImage`);
  expect(await checkSite(base, get)).toEqual([]);
  expect(await checkSite("https://elsewhere.example", get)).toEqual([
    "https://elsewhere.example/update.json does not answer",
  ]);
});
