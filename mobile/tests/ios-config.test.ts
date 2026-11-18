import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_ID,
  capacitorConfigFor,
  errorPageFor,
  iconProblem,
  iosConfigFrom,
  patchInfoPlist,
  USER_AGENT_TOKEN,
  versionSettings,
} from "../scripts/ios-config";

/**
 * The names an iOS build is given, and the two edits made to the project Capacitor generates.
 *
 * What is protected: the app is the product's own (one bundle identifier, for every customer) and
 * opens the Ark Link host, never a deployment's site; nothing a build must be given is defaulted; a
 * name that would break the project's files is refused; the app's user agent and return address
 * agree with the web app's and the server's, which are written in other files; and an icon the App
 * Store would refuse is refused here, before a build, instead of after an upload.
 */

const root = join(import.meta.dir, "..", "..");
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf8");

/** What every build must be given. The team and the return scheme are optional (below). */
const environment = {
  ARK_LINK_URL: "https://link.example",
  ARK_APP_NAME: "Ark",
  ARK_IOS_BUILD_NUMBER: "4",
};
const build = (extra: Record<string, string | undefined> = {}) =>
  iosConfigFrom({ ...environment, ...extra }, "0.0.15");

describe("the configuration", () => {
  test("is read from the environment, and the app is always the product's own", () => {
    expect(build()).toEqual({
      bundleId: "blackark.arkagent",
      teamId: null,
      appName: "Ark",
      linkUrl: "https://link.example",
      linkHost: "link.example",
      urlScheme: null,
      versionName: "0.0.15",
      buildNumber: 4,
    });
    expect(BUNDLE_ID).toBe("blackark.arkagent");
    expect(build({ ARK_IOS_VERSION_NAME: "1.4" }).versionName).toBe("1.4");
  });

  test("every name a build must be given is required, and says which is missing", () => {
    for (const name of Object.keys(environment)) {
      expect(() => build({ [name]: undefined })).toThrow(`${name} is not set.`);
    }
  });

  test("the start address is the Ark Link host, and nothing else", () => {
    expect(build({ ARK_LINK_URL: "https://LINK.blackark.uk" })).toMatchObject({
      linkUrl: "https://link.blackark.uk",
      linkHost: "link.blackark.uk",
    });
    for (const bad of [
      "http://link.example",
      "https://link.example/pair",
      "https://link.example:8443",
      "https://user@link.example",
      "https://127.0.0.1",
      "https://localhost",
      "link.example",
    ]) {
      expect(() => build({ ARK_LINK_URL: bad })).toThrow(/ARK_LINK_URL/);
    }
  });

  test("the team is only needed to sign, and is checked when it is given", () => {
    expect(build({ ARK_IOS_TEAM_ID: "ABCDE12345" }).teamId).toBe("ABCDE12345");
    for (const bad of ["abcde12345", "ABCDE1234", "ABCDE12345.blackark"]) {
      expect(() => build({ ARK_IOS_TEAM_ID: bad })).toThrow(/ARK_IOS_TEAM_ID/);
    }
  });

  test("the return scheme is optional, and when given is an app's own, never one a browser or the system uses", () => {
    expect(build({ ARK_IOS_URL_SCHEME: "arkapp" }).urlScheme).toBe("arkapp");
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

  test("the app opens the Ark Link host, stays on it, and has nothing of the web app bundled", () => {
    expect(config).toMatchObject({
      appId: "blackark.arkagent",
      appName: "Ark",
      server: {
        url: "https://link.example",
        cleartext: false,
        allowNavigation: ["link.example"],
      },
    });
  });

  test("a host that cannot be reached shows the app's own page instead of a blank window", () => {
    expect(config.server.errorPath).toBe("index.html");
    const page = source("mobile", "ios", "www", "index.html");
    // In both languages the app is offered in, with a way to try again at the same host.
    expect(page).toContain('lang="el"');
    expect(page).toContain('lang="en"');
    expect(page).toContain("location.replace");
  });

  test("the page's way to try again is told the host, once, and nothing else changes", () => {
    const page = source("mobile", "ios", "www", "index.html");
    const told = errorPageFor(page, build());
    expect(told).toContain('<html lang="en" data-link="https://link.example">');
    expect(
      told.replace(' data-link="https://link.example"', ' data-link=""'),
    ).toBe(page);
    expect(() => errorPageFor(told, build())).toThrow(/data-link/);
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

  test("gets the export-compliance answer, and no address scheme unless one is given", () => {
    const patched = patchInfoPlist(template, build());
    expect(patched).toContain(
      "<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>",
    );
    expect(patched).not.toContain("CFBundleURLTypes");
    expect(patched.endsWith("</dict>\n</plist>\n")).toBe(true);
  });

  test("says why it asks for the microphone and the camera, which the app's pages use", () => {
    // Without these iOS ends the app the moment a page asks: dictation and voice ask for the
    // microphone, and a file picker offers to take a photo.
    const patched = patchInfoPlist(template, build());
    expect(patched).toMatch(
      /<key>NSMicrophoneUsageDescription<\/key>\n\t<string>[^<]*dictate[^<]*<\/string>/,
    );
    expect(patched).toMatch(
      /<key>NSCameraUsageDescription<\/key>\n\t<string>[^<]*photo[^<]*<\/string>/,
    );
    expect(() =>
      patchInfoPlist(
        template.replace(
          "</dict>",
          "\t<key>NSCameraUsageDescription</key>\n\t<string>x</string>\n</dict>",
        ),
        build(),
      ),
    ).toThrow(/already has NSCameraUsageDescription/);
  });

  test("gets the address scheme when one is given, and stays one valid plist", () => {
    const patched = patchInfoPlist(
      template,
      build({ ARK_IOS_URL_SCHEME: "arkapp" }),
    );
    expect(patched).toContain("<string>arkapp</string>");
    expect(patched).toContain("<string>blackark.arkagent</string>");
    expect(patched).toContain(
      "<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>",
    );
    // What was there is still there, and the file still ends the way a plist does.
    expect(patched).toContain("<key>CFBundleDisplayName</key>");
    expect(patched.endsWith("</dict>\n</plist>\n")).toBe(true);
    expect(patched.match(/<\/dict>\s*<\/plist>/g)).toHaveLength(1);
  });

  test("is not edited twice, and a file of an unexpected shape is not edited at all", () => {
    const withScheme = build({ ARK_IOS_URL_SCHEME: "arkapp" });
    const once = patchInfoPlist(template, withScheme);
    expect(() => patchInfoPlist(once, withScheme)).toThrow(/already has/);
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

  test("the workflow builds every push to an iOS branch for the simulator, unsigned and with no secret", () => {
    const workflow = source(".github", "workflows", "mobile-ios.yml");
    const check = workflow.slice(
      workflow.indexOf("  check:"),
      workflow.indexOf("  release:"),
    );
    expect(workflow).toMatch(/branches: \[main, "claude\/ios-\*\*"\]/);
    expect(check).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(check).toContain("-sdk iphonesimulator");
    expect(check).not.toMatch(/secrets\.|vars\./);
  });
});
