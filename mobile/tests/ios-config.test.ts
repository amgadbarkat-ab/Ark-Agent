import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capacitorConfigFor,
  iconProblem,
  iosConfigFrom,
  patchInfoPlist,
  USER_AGENT_TOKEN,
  versionSettings,
} from "../scripts/ios-config";

/**
 * The names an iOS build is given, and the two edits made to the project Capacitor generates.
 *
 * What is protected: nothing about a deployment is ever defaulted; a name that would break the
 * project's files is refused; the app's user agent and return address agree with the web app's and
 * the server's, which are written in other files; and an icon the App Store would refuse is refused
 * here, before a build, instead of after an upload.
 */

const root = join(import.meta.dir, "..", "..");
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf8");

const environment = {
  ARK_IOS_APP_ID: "ABCDE12345.com.example.ark",
  ARK_APP_URL: "https://ark.example",
  ARK_APP_NAME: "Ark",
  ARK_IOS_URL_SCHEME: "arkapp",
  ARK_IOS_BUILD_NUMBER: "4",
};
const build = (extra: Record<string, string | undefined> = {}) =>
  iosConfigFrom({ ...environment, ...extra }, "0.0.15");

describe("the configuration", () => {
  test("is read from the environment, with the team and the bundle identifier taken from the one name", () => {
    expect(build()).toEqual({
      teamId: "ABCDE12345",
      bundleId: "com.example.ark",
      appName: "Ark",
      siteUrl: "https://ark.example",
      siteHost: "ark.example",
      urlScheme: "arkapp",
      versionName: "0.0.15",
      buildNumber: 4,
    });
    expect(build({ ARK_IOS_VERSION_NAME: "1.4" }).versionName).toBe("1.4");
  });

  test("every name the deployment must give is required, and says which is missing", () => {
    for (const name of Object.keys(environment)) {
      expect(() => build({ [name]: undefined })).toThrow(`${name} is not set.`);
    }
  });

  test("the identifier is the one the server publishes", () => {
    for (const bad of [
      "com.example.ark",
      "abcde12345.com.example.ark",
      "ABCDE12345.ark",
    ]) {
      expect(() => build({ ARK_IOS_APP_ID: bad })).toThrow(
        /not an iOS app identifier/,
      );
    }
  });

  test("the scheme is an app's own, never one a browser or the system uses", () => {
    for (const bad of ["https", "javascript", "Ark", "ab", "ark app"]) {
      expect(() => build({ ARK_IOS_URL_SCHEME: bad })).toThrow(
        /not an app's own address scheme/,
      );
    }
  });

  test("the name under the icon cannot break the project's files", () => {
    for (const name of [
      "Ark & Co",
      "Ark <b>",
      'Ark "x"',
      "Ark\nx",
      "A".repeat(31),
    ]) {
      expect(() => build({ ARK_APP_NAME: name })).toThrow(/ARK_APP_NAME/);
    }
  });

  test("the site is the same kind of address the Android app takes", () => {
    for (const bad of [
      "http://ark.example",
      "https://ark.example/app",
      "https://localhost",
    ]) {
      expect(() => build({ ARK_APP_URL: bad })).toThrow(/ARK_APP_URL/);
    }
  });

  test("the version is what the App Store accepts, and the build number goes up", () => {
    for (const bad of ["1.2.3.4", "1.0-beta", "latest", "1."]) {
      expect(() => build({ ARK_IOS_VERSION_NAME: bad })).toThrow(
        /VERSION_NAME/,
      );
    }
    for (const bad of ["0", "-1", "1.5", "x", "2000000001"]) {
      expect(() => build({ ARK_IOS_BUILD_NUMBER: bad })).toThrow(
        /BUILD_NUMBER/,
      );
    }
  });

  test("the version goes to the build as settings, not into the generated project", () => {
    expect(versionSettings(build({ ARK_IOS_VERSION_NAME: "2.0.1" }))).toEqual([
      "MARKETING_VERSION=2.0.1",
      "CURRENT_PROJECT_VERSION=4",
    ]);
  });
});

describe("what Capacitor is told", () => {
  const config = capacitorConfigFor(build());

  test("the app is a window onto the site, kept on it, with nothing of the web app bundled", () => {
    expect(config).toMatchObject({
      appId: "com.example.ark",
      appName: "Ark",
      server: {
        url: "https://ark.example",
        cleartext: false,
        allowNavigation: ["ark.example"],
      },
    });
  });

  test("the user agent token is the one the web app looks for", () => {
    expect(config.ios.appendUserAgent).toBe(USER_AGENT_TOKEN);
    const web = /IOS_USER_AGENT_TOKEN = "([^"]+)"/.exec(
      source("app", "src", "lib", "store-app.ts"),
    );
    expect(web?.[1]).toBe(USER_AGENT_TOKEN);
  });

  test("the return address is the one the server's page sends people to and the web app waits for", () => {
    const server = /APP_RETURN_HOST = "([^"]+)"/.exec(
      source("server", "src", "auth", "native-browser.ts"),
    );
    const web = /RETURN_HOST = "([^"]+)"/.exec(
      source("app", "src", "lib", "native", "sign-in.ts"),
    );
    expect(server?.[1]).toBeTruthy();
    expect(web?.[1]).toBe(server?.[1]);
  });
});

describe("the Info.plist", () => {
  // What Capacitor's template ends with, which is all the edit relies on.
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Ark</string>
\t<key>UIViewControllerBasedStatusBarAppearance</key>
\t<true/>
</dict>
</plist>
`;

  test("gets the address scheme and the export-compliance answer, and stays one valid plist", () => {
    const patched = patchInfoPlist(template, build());
    expect(patched).toContain("<string>arkapp</string>");
    expect(patched).toContain("<string>com.example.ark</string>");
    expect(patched).toContain(
      "<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>",
    );
    // What was there is still there, and the file still ends the way a plist does.
    expect(patched).toContain("<key>CFBundleDisplayName</key>");
    expect(patched.endsWith("</dict>\n</plist>\n")).toBe(true);
    expect(patched.match(/<\/dict>\s*<\/plist>/g)).toHaveLength(1);
  });

  test("is not edited twice, and a file of an unexpected shape is not edited at all", () => {
    const once = patchInfoPlist(template, build());
    expect(() => patchInfoPlist(once, build())).toThrow(/already has/);
    expect(() => patchInfoPlist("<plist><dict>", build())).toThrow(
      /not in the shape expected/,
    );
  });
});

describe("the icon", () => {
  /** The first 33 bytes of a PNG: signature and header, which is all that is read. */
  const png = (
    width: number,
    height: number,
    colourType: number,
    extra = "",
  ) => {
    const bytes = new Uint8Array(33);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set(new TextEncoder().encode("IHDR"), 12);
    view.setUint32(16, width);
    view.setUint32(20, height);
    bytes[24] = 8;
    bytes[25] = colourType;
    if (!extra) return bytes;
    const more = new Uint8Array(bytes.length + extra.length);
    more.set(bytes);
    more.set(new TextEncoder().encode(extra), bytes.length);
    return more;
  };

  test("is accepted when it is 1024 by 1024 with no transparency", () => {
    expect(iconProblem(png(1024, 1024, 2))).toBeNull();
  });

  test("is refused, with the reason, when the App Store would refuse it", () => {
    expect(iconProblem(png(512, 512, 2))).toMatch(/512 by 512/);
    expect(iconProblem(png(1024, 1024, 6))).toMatch(/transparency/);
    expect(iconProblem(png(1024, 1024, 4))).toMatch(/transparency/);
    expect(iconProblem(png(1024, 1024, 3, "tRNS"))).toMatch(/transparent/);
    expect(
      iconProblem(
        new TextEncoder().encode("not a png at all, just text........"),
      ),
    ).toMatch(/not a PNG/);
    expect(iconProblem(new Uint8Array(4))).toMatch(/not a PNG/);
  });
});

describe("the project", () => {
  test("the Xcode project is generated, never committed, and a fallback page exists for Capacitor", () => {
    expect(source("mobile", "ios", ".gitignore")).toMatch(/^ios\/$/m);
    expect(source("mobile", "ios", "www", "index.html")).toContain("<html");
  });

  test("the Capacitor packages the shell is built with are the ones the web app calls", () => {
    const shell = JSON.parse(source("mobile", "ios", "package.json")) as {
      dependencies: Record<string, string>;
    };
    const web = JSON.parse(source("app", "package.json")) as {
      dependencies: Record<string, string>;
    };
    for (const name of [
      "@capacitor/core",
      "@capacitor/app",
      "@capacitor/browser",
    ]) {
      const major = (range: string | undefined) => /\d+/.exec(range ?? "")?.[0];
      expect(major(shell.dependencies[name])).toBe(
        major(web.dependencies[name]),
      );
    }
    expect(shell.dependencies["@capacitor/ios"]).toBeTruthy();
  });
});
