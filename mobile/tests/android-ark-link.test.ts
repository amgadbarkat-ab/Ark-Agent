import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLinkRelay } from "../../infra/ark-link/relay";
import { ARK_LINK_PATHS } from "../../shared/ark-link";
import { androidConfigFrom, propertiesFor } from "../scripts/android-config";

/**
 * The Android app opens the Ark Link host (#149), not one deployment's site: every customer's desktop
 * is reached through it, and the relay, not the desktop, vouches for the app.
 *
 * What is held: the app built for the link host is tied to that origin; the relay's
 * `assetlinks.json` names the same package the app is built as, so Android drops the address bar;
 * and an unpaired phone that opens the app lands on the pairing page on the same origin, so it never
 * leaves the app to pair.
 */

const root = join(import.meta.dir, "..", "..");
const LINK = "https://link.blackark.uk";
const config = androidConfigFrom(
  {
    // The owner's package (docs/ark/19-mobile.md). Made-up everywhere else.
    ARK_ANDROID_APP_ID: "blackark.arkagent",
    ARK_APP_URL: LINK,
    ARK_APP_NAME: "ArkAgent",
    ARK_ANDROID_VERSION_CODE: "1",
  },
  { theme_color: "#111111", background_color: "#111111" },
  "0.1.48",
);

const relay = createLinkRelay({
  linkOrigin: LINK,
  installs: () => [],
  apps: {
    android: {
      appId: config.applicationId,
      certFingerprints: [Array(32).fill("AB").join(":")],
    },
  },
  log: () => undefined,
});
const server = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
const base = `http://localhost:${server.port}`;
afterAll(() => {
  relay.stop();
  void server.stop(true);
});

describe("the Android app and Ark Link", () => {
  test("the app is built for the link host", () => {
    const text = propertiesFor(config);
    expect(text).toContain(`siteUrl=${LINK}\n`);
    expect(text).toContain("siteHost=link.blackark.uk\n");
    expect(text).toContain("applicationId=blackark.arkagent\n");
  });

  test("the relay vouches for the same package the app claims the link host for", async () => {
    const response = await fetch(`${base}${ARK_LINK_PATHS.assetLinks}`);
    expect(response.headers.get("content-type")).toContain("application/json");
    const [statement] = await response.json();
    expect(statement.target.package_name).toBe(config.applicationId);
    expect(statement.relation).toEqual([
      "delegate_permission/common.handle_all_urls",
    ]);
    // The app's side: Gradle writes its asset statement for the site it was given, the link host.
    const gradle = readFileSync(
      join(root, "mobile", "android", "app", "build.gradle"),
      "utf8",
    );
    expect(gradle).toMatch(/namespace: 'web', site: arkValue\('siteUrl'\)/);
    expect(config.siteUrl).toBe(LINK);
  });

  test("an unpaired phone opening the app is sent to the pairing page, on the same origin", async () => {
    const response = await fetch(`${base}/`, {
      redirect: "manual",
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(response.status).toBe(302);
    // A path, not an address: it stays on the link host, inside the app, with no address bar.
    expect(response.headers.get("location")).toBe(ARK_LINK_PATHS.pairPage);
    const page = await fetch(`${base}${ARK_LINK_PATHS.pairPage}`);
    expect(page.status).toBe(200);
  });
});
