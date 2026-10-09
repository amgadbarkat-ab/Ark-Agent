import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  androidConfigFrom,
  propertiesFor,
  siteFrom,
  type WebManifestColors,
} from "../scripts/android-config";

/**
 * The names an Android build is given, held before Gradle sees them.
 *
 * What is protected: nothing about a deployment is ever defaulted (a package name cannot be changed
 * once published, and an app tied to the wrong site is an app that shows an address bar); a value
 * that would break the generated file or the string resource it ends up in is refused; and the
 * launcher icon is the web app's icon, not a copy that has drifted.
 */

const root = join(import.meta.dir, "..", "..");
const colours = { theme_color: "#FAFAFA", background_color: "#ffffff" };

const environment = {
  ARK_ANDROID_APP_ID: "com.example.ark",
  ARK_APP_URL: "https://ark.example",
  ARK_APP_NAME: "Ark",
  ARK_ANDROID_VERSION_CODE: "7",
};

const build = (
  extra: Record<string, string | undefined> = {},
  manifest: WebManifestColors = colours,
) => androidConfigFrom({ ...environment, ...extra }, manifest, "0.0.15");

describe("the site", () => {
  test("is a domain served over https, reduced to its origin", () => {
    expect(siteFrom("https://ark.example")).toEqual({
      url: "https://ark.example",
      host: "ark.example",
    });
    expect(siteFrom("https://App.Ark.Example/")).toEqual({
      url: "https://app.ark.example",
      host: "app.ark.example",
    });
    expect(siteFrom("https://ark.example:443")).toEqual({
      url: "https://ark.example",
      host: "ark.example",
    });
  });

  test("is refused when an Android app could not be tied to it, each with its reason", () => {
    const refused: [string, RegExp][] = [
      ["http://ark.example", /https/],
      ["https://ark.example:8443", /port/],
      ["https://user:pass@ark.example", /user name/],
      ["https://ark.example/app", /no path/],
      ["https://ark.example/?x=1", /no path/],
      ["https://ark.example/#top", /no path/],
      ["https://localhost", /domain name/],
      ["https://10.0.0.5", /domain name/],
      ["https://[::1]", /domain name/],
      ["ark.example", /not an address/],
      ["", /not an address/],
    ];
    for (const [address, reason] of refused) {
      expect(() => siteFrom(address)).toThrow(reason);
    }
  });
});

describe("the configuration", () => {
  test("is read from the environment and the web manifest, and nothing is invented", () => {
    expect(build()).toEqual({
      applicationId: "com.example.ark",
      appName: "Ark",
      siteUrl: "https://ark.example",
      siteHost: "ark.example",
      themeColor: "#fafafa",
      backgroundColor: "#ffffff",
      versionCode: 7,
      versionName: "0.0.15",
    });
    expect(build({ ARK_ANDROID_VERSION_NAME: "1.4.0" }).versionName).toBe(
      "1.4.0",
    );
  });

  test("every name the deployment must give is required, and says which is missing", () => {
    for (const name of Object.keys(environment)) {
      expect(() => build({ [name]: undefined })).toThrow(`${name} is not set.`);
      expect(() => build({ [name]: "  " })).toThrow(`${name} is not set.`);
    }
  });

  test("a package name is the same kind of name the server will publish", () => {
    expect(() => build({ ARK_ANDROID_APP_ID: "ark" })).toThrow(
      /not an Android package name/,
    );
    expect(() =>
      build({ ARK_ANDROID_APP_ID: "com.example.ark-agent" }),
    ).toThrow(/not an Android package name/);
  });

  test("the name under the icon cannot break the string resource or the file it travels in", () => {
    for (const name of [
      "Ark & Co",
      "Ark's",
      'Ark "Agent"',
      "Ark <b>",
      "Ark\nAgent",
      "Ark\\Agent",
      "A".repeat(31),
      "",
    ]) {
      expect(() => build({ ARK_APP_NAME: name })).toThrow(
        /ARK_APP_NAME|not set/,
      );
    }
    for (const name of ["Ark", "ArkAgent", "Ark-Agent 2", "Ünïcode Ark"]) {
      expect(build({ ARK_APP_NAME: name }).appName).toBe(name);
    }
    // Spaces around it are not part of the name.
    expect(build({ ARK_APP_NAME: "  Ark " }).appName).toBe("Ark");
  });

  test("a version code is a whole number that Google Play will take", () => {
    for (const code of ["0", "-1", "1.5", "abc", "2100000001", "1e3", "07x"]) {
      expect(() => build({ ARK_ANDROID_VERSION_CODE: code })).toThrow(
        /VERSION_CODE/,
      );
    }
    expect(build({ ARK_ANDROID_VERSION_CODE: "2100000000" }).versionCode).toBe(
      2_100_000_000,
    );
  });

  test("a version name is a version", () => {
    expect(() => build({ ARK_ANDROID_VERSION_NAME: "latest" })).toThrow(
      /VERSION_NAME/,
    );
    expect(() => build({ ARK_ANDROID_VERSION_NAME: "1.0\nx=1" })).toThrow(
      /VERSION_NAME/,
    );
  });

  test("the colours come from the web app and must be real colours", () => {
    expect(() =>
      build({}, { theme_color: "red", background_color: "#ffffff" }),
    ).toThrow(/theme_color and background_color/);
    expect(() =>
      build({}, { theme_color: "#fff", background_color: "#ffffff" }),
    ).toThrow(/theme_color and background_color/);
    expect(() => build({}, {})).toThrow(/theme_color and background_color/);
  });
});

describe("the file Gradle reads", () => {
  test("holds each value once, as plain text, and nothing secret", () => {
    const text = propertiesFor(build());
    expect(text).toContain("applicationId=com.example.ark\n");
    expect(text).toContain("siteUrl=https://ark.example\n");
    expect(text).toContain("versionCode=7\n");
    // Signing material is read by Gradle from the environment and has no place here.
    expect(text).not.toMatch(/password|keystore|alias/i);
    const lines = text
      .split("\n")
      .filter((line) => !line.startsWith("#") && line);
    expect(lines).toHaveLength(8);
  });
});

describe("the project", () => {
  const read = (...parts: string[]) =>
    readFileSync(join(root, "mobile", "android", ...parts));

  test("the launcher icon is the web app's own icon, so a new brand reaches both", () => {
    expect(
      read(
        "app",
        "src",
        "main",
        "res",
        "mipmap-xxxhdpi",
        "ic_launcher.png",
      ).equals(
        readFileSync(join(root, "app", "public", "icons", "icon-192.png")),
      ),
    ).toBe(true);
  });

  test("no deployment's name is written into the project", () => {
    const manifest = read(
      "app",
      "src",
      "main",
      "AndroidManifest.xml",
    ).toString();
    // Every address and name in it is a placeholder or a resource filled from ark.properties.
    expect(manifest).toMatch(/\$\{siteUrl\}/);
    expect(manifest).toMatch(/\$\{siteHost\}/);
    expect(manifest).not.toMatch(/https?:\/\/(?!schemas\.android\.com)/);
    const gradle = read("app", "build.gradle").toString();
    expect(gradle).toMatch(/applicationId arkValue\('applicationId'\)/);
  });

  test("the file with a deployment's names is never committed", () => {
    expect(read(".gitignore").toString()).toMatch(/^ark\.properties$/m);
  });

  test("the Gradle wrapper is pinned to a checksum", () => {
    expect(
      read("gradle", "wrapper", "gradle-wrapper.properties").toString(),
    ).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m);
  });
});
