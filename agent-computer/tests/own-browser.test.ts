import { describe, expect, test } from "bun:test";
import {
  isPersonsOwnProfile,
  isPrivateDestination,
  OWN_BROWSER_HAS_NO_FILES,
  OWN_BROWSER_HAS_NO_RESET,
  OWN_BROWSER_IGNORED_DEFAULT_ARGS,
  ownBrowserFromEnv,
  ownBrowserRefuses,
  personsProfileFolders,
} from "../src/own-browser";

/**
 * The rules for driving the person's own browser (device control, phase 1), without a browser.
 *
 * The live half, against a real Chromium standing in for the person's, is
 * `own-browser-live.test.ts`.
 */

describe("which browser this process drives", () => {
  test("a container, unless the desktop names the person's browser and the dedicated profile", () => {
    expect(ownBrowserFromEnv({})).toBeNull();
    expect(
      ownBrowserFromEnv({ COMPUTER_OWN_BROWSER_EXECUTABLE: " " }),
    ).toBeNull();
    expect(
      ownBrowserFromEnv(
        {
          COMPUTER_OWN_BROWSER_EXECUTABLE: "/usr/bin/google-chrome",
          COMPUTER_OWN_BROWSER_PROFILE:
            "/home/maria/.local/share/ArkAgent/own-browser-profile",
          HOME: "/home/maria",
        },
        "linux",
      ),
    ).toEqual({
      executable: "/usr/bin/google-chrome",
      profileDir: "/home/maria/.local/share/ArkAgent/own-browser-profile",
      headless: false,
    });
  });

  test("without a dedicated profile folder it refuses to start", () => {
    for (const profile of [undefined, "", "relative/profile"]) {
      expect(() =>
        ownBrowserFromEnv(
          {
            COMPUTER_OWN_BROWSER_EXECUTABLE: "/usr/bin/google-chrome",
            COMPUTER_OWN_BROWSER_PROFILE: profile,
          },
          "linux",
        ),
      ).toThrow();
    }
  });

  test("the person's own profiles, with their saved passwords, are never the one opened", () => {
    const cases: Array<[NodeJS.Platform, Record<string, string>, string]> = [
      ["linux", { HOME: "/home/maria" }, "/home/maria/.config/google-chrome"],
      [
        "linux",
        { HOME: "/home/maria" },
        "/home/maria/.config/microsoft-edge/Default",
      ],
      [
        "darwin",
        { HOME: "/Users/maria" },
        "/Users/maria/Library/Application Support/Google/Chrome/Profile 1",
      ],
      [
        "darwin",
        { HOME: "/Users/maria" },
        "/users/maria/library/application support/microsoft edge",
      ],
    ];
    for (const [platform, env, profile] of cases) {
      expect(isPersonsOwnProfile(profile, env, platform)).toBe(true);
      expect(() =>
        ownBrowserFromEnv(
          {
            ...env,
            COMPUTER_OWN_BROWSER_EXECUTABLE: "/chrome",
            COMPUTER_OWN_BROWSER_PROFILE: profile,
          },
          platform,
        ),
      ).toThrow();
    }
    // The folders a person's Chrome and Edge keep on Windows, named under their local app data.
    const windows = personsProfileFolders(
      { LOCALAPPDATA: "C:/Users/Maria/AppData/Local" },
      "win32",
    );
    expect(windows.some((folder) => folder.includes("Edge"))).toBe(true);
    expect(windows.every((folder) => folder.endsWith("User Data"))).toBe(true);
    // A folder beside them is not one of them.
    expect(
      isPersonsOwnProfile(
        "/home/maria/.config/google-chrome-arkagent",
        { HOME: "/home/maria" },
        "linux",
      ),
    ).toBe(false);
  });

  test("Playwright's test-only defaults that weaken a real browser are dropped", () => {
    for (const weakening of [
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-client-side-phishing-detection",
      "--disable-popup-blocking",
    ]) {
      expect(OWN_BROWSER_IGNORED_DEFAULT_ARGS).toContain(weakening);
    }
    // Extensions stay off in the employees' profile: one would read every page they open.
    expect(OWN_BROWSER_IGNORED_DEFAULT_ARGS).not.toContain(
      "--disable-extensions",
    );
  });
});

describe("what the person's browser does not have", () => {
  test("no files, no shell and no reset; the browser paths are untouched", () => {
    for (const path of [
      "/exec",
      "/files/read",
      "/files/write",
      "/files/list",
    ]) {
      expect(ownBrowserRefuses(path)).toBe(OWN_BROWSER_HAS_NO_FILES);
    }
    expect(ownBrowserRefuses("/computers/reset")).toBe(
      OWN_BROWSER_HAS_NO_RESET,
    );
    for (const path of [
      "/navigate",
      "/snapshot",
      "/click",
      "/type",
      "/key",
      "/scroll",
      "/control/take",
      "/computers/stop",
    ]) {
      expect(ownBrowserRefuses(path)).toBeNull();
    }
  });
});

describe("the person's own network is out of reach (finding 1)", () => {
  test("router pages, printers, NAS boxes and this computer are refused", () => {
    for (const address of [
      "http://192.168.1.1/",
      "https://10.0.0.5/admin",
      "http://172.16.4.2",
      "http://127.0.0.1:3001/api",
      "http://localhost:5432",
      "http://printer.local/",
      "http://nas.localhost/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:8080",
      "http://[fe80::1]/",
      "http://[fd00::5]/",
      "http://[::ffff:192.168.1.1]/",
      "http://0.0.0.0:22",
      "ws://192.168.1.10/socket",
      "http://192.168.1.1./",
      "http://100.100.100.200/",
    ]) {
      expect(isPrivateDestination(address)).toBe(true);
    }
  });

  test("public sites, and the addresses a page carries inline, are allowed", () => {
    for (const address of [
      "https://www.aade.gr/",
      "https://ec.europa.eu/taxation_customs/vies/",
      "http://8.8.8.8/",
      "https://[2001:db8::1]/",
      "data:text/html,hello",
      "blob:https://example.com/123",
      "https://traps.example/03-shipping-update.html",
    ]) {
      expect(isPrivateDestination(address)).toBe(false);
    }
  });
});
