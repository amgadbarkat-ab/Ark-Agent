import { expect, test } from "bun:test";
import { buildManifest, platformOf } from "./update-manifest";

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
        signature: "not an update",
      },
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

test("only the three update files count; installers people download by hand do not", () => {
  expect(platformOf("x/ArkAgent_0.1.57_aarch64.dmg")).toBeNull();
  expect(platformOf("x/ArkAgent_0.1.57_amd64.deb")).toBeNull();
  expect(platformOf("x/ArkAgent-0.1.57-1.x86_64.rpm")).toBeNull();
  expect(platformOf("x/ArkAgent_0.1.57_x64-setup.exe")).toBe("windows-x86_64");
});
