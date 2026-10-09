import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  appleAppSiteAssociation,
  assetLinks,
  isAndroidAppId,
  isIosAppId,
  normalizeFingerprint,
} from "../src/mobile/links";
import { testEnvironment } from "./support/environment";

/**
 * What Android and iOS read from this website to believe a store app belongs to it.
 *
 * What is protected: neither file is ever served unless the operator named the app; a fingerprint
 * that is not a whole SHA-256 is refused at start-up instead of being published and failing silently
 * on a phone; nothing under `/.well-known/` ever answers with the app's HTML.
 */

const FINGERPRINT = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, "0").toUpperCase(),
).join(":");

describe("the names", () => {
  test("an Android package name is dotted parts of letters, digits and underscores", () => {
    for (const good of ["com.example.ark", "com.example.ark_agent", "a.b"]) {
      expect(isAndroidAppId(good)).toBe(true);
    }
    for (const bad of [
      "ark",
      "com..ark",
      "com.example.",
      "1com.example",
      "com.example.ark app",
      "com.example.ark-agent",
      "",
      `com.${"a".repeat(300)}`,
    ]) {
      expect(isAndroidAppId(bad)).toBe(false);
    }
  });

  test("an iOS identifier is the ten-character team, a dot, then the bundle identifier", () => {
    expect(isIosAppId("ABCDE12345.com.example.ark")).toBe(true);
    for (const bad of [
      "com.example.ark",
      "ABCDE1234.com.example.ark",
      "abcde12345.com.example.ark",
      "ABCDE12345.ark",
      "ABCDE12345.com.example.ark app",
    ]) {
      expect(isIosAppId(bad)).toBe(false);
    }
  });

  test("a fingerprint is accepted as copied from anywhere, and only if it is whole", () => {
    expect(normalizeFingerprint(FINGERPRINT)).toBe(FINGERPRINT);
    expect(normalizeFingerprint(FINGERPRINT.toLowerCase())).toBe(FINGERPRINT);
    expect(normalizeFingerprint(FINGERPRINT.replaceAll(":", ""))).toBe(
      FINGERPRINT,
    );
    expect(normalizeFingerprint(`  ${FINGERPRINT}\n`)).toBe(FINGERPRINT);
    // Half a key, a key and a bit, and something that is not hex.
    expect(normalizeFingerprint(FINGERPRINT.slice(0, 47))).toBeUndefined();
    expect(normalizeFingerprint(`${FINGERPRINT}:00`)).toBeUndefined();
    expect(
      normalizeFingerprint(FINGERPRINT.replace(/0/g, "Z")),
    ).toBeUndefined();
    expect(normalizeFingerprint("")).toBeUndefined();
  });
});

describe("the documents", () => {
  test("Android's names the package and the keys, and asks only for links to open the app", () => {
    expect(
      assetLinks({ appId: "com.example.ark", certFingerprints: [FINGERPRINT] }),
    ).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.example.ark",
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });

  test("iOS's keeps the API out of the app and sends every other link into it", () => {
    const document = appleAppSiteAssociation({
      appId: "ABCDE12345.com.example.ark",
    });
    expect(document.applinks.details[0]?.appIDs).toEqual([
      "ABCDE12345.com.example.ark",
    ]);
    // Order matters in this file: the first component that matches decides.
    expect(document.applinks.details[0]?.components).toEqual([
      { "/": "/api/*", exclude: true },
      { "/": "*" },
    ]);
    expect(document.webcredentials.apps).toEqual([
      "ABCDE12345.com.example.ark",
    ]);
  });
});

describe("the configuration", () => {
  const load = (extra: Record<string, string>) =>
    loadConfig(testEnvironment(extra));

  test("naming nothing publishes nothing", () => {
    expect(load({}).mobileLinks).toBeUndefined();
  });

  test("an Android app needs its package and its key together", () => {
    expect(() => load({ ARK_ANDROID_APP_ID: "com.example.ark" })).toThrow(
      /go together/,
    );
    expect(() => load({ ARK_ANDROID_CERT_SHA256: FINGERPRINT })).toThrow(
      /go together/,
    );
    const config = load({
      ARK_ANDROID_APP_ID: "com.example.ark",
      ARK_ANDROID_CERT_SHA256: `${FINGERPRINT.toLowerCase()}, ${FINGERPRINT}`,
    });
    // Written the same two ways, published once.
    expect(config.mobileLinks).toEqual({
      android: { appId: "com.example.ark", certFingerprints: [FINGERPRINT] },
    });
  });

  test("a wrong name or a part of a key is refused when the server starts", () => {
    expect(() =>
      load({
        ARK_ANDROID_APP_ID: "ark",
        ARK_ANDROID_CERT_SHA256: FINGERPRINT,
      }),
    ).toThrow(/ARK_ANDROID_APP_ID is not an Android package name/);
    expect(() =>
      load({
        ARK_ANDROID_APP_ID: "com.example.ark",
        ARK_ANDROID_CERT_SHA256: `${FINGERPRINT},AB:CD`,
      }),
    ).toThrow(/ARK_ANDROID_CERT_SHA256 holds a value that is not/);
    expect(() => load({ ARK_IOS_APP_ID: "com.example.ark" })).toThrow(
      /ARK_IOS_APP_ID is not an iOS app identifier/,
    );
  });

  test("an iOS app needs only its identifier", () => {
    expect(
      load({ ARK_IOS_APP_ID: "ABCDE12345.com.example.ark" }).mobileLinks,
    ).toEqual({ ios: { appId: "ABCDE12345.com.example.ark" } });
  });
});

describe("what the site answers", () => {
  const get = (extra: Record<string, string>, path: string) =>
    createApp(loadConfig(testEnvironment(extra))).request(
      `http://openbot.local${path}`,
    );

  test("with nothing named, both files are a plain 404 and not a page", async () => {
    for (const path of [
      "/.well-known/assetlinks.json",
      "/.well-known/apple-app-site-association",
      "/.well-known/anything-else",
    ]) {
      const response = await get({}, path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toContain("text/html");
    }
  });

  test("named, each is JSON, public and cacheable, and the other stays 404", async () => {
    const android = await get(
      {
        ARK_ANDROID_APP_ID: "com.example.ark",
        ARK_ANDROID_CERT_SHA256: FINGERPRINT,
      },
      "/.well-known/assetlinks.json",
    );
    expect(android.status).toBe(200);
    expect(android.headers.get("content-type")).toContain("application/json");
    expect(android.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await android.json()).toEqual(
      assetLinks({ appId: "com.example.ark", certFingerprints: [FINGERPRINT] }),
    );
    expect(
      (
        await get(
          {
            ARK_ANDROID_APP_ID: "com.example.ark",
            ARK_ANDROID_CERT_SHA256: FINGERPRINT,
          },
          "/.well-known/apple-app-site-association",
        )
      ).status,
    ).toBe(404);

    const ios = await get(
      { ARK_IOS_APP_ID: "ABCDE12345.com.example.ark" },
      "/.well-known/apple-app-site-association",
    );
    expect(ios.status).toBe(200);
    expect(ios.headers.get("content-type")).toContain("application/json");
    expect(await ios.json()).toEqual(
      appleAppSiteAssociation({ appId: "ABCDE12345.com.example.ark" }),
    );
  });

  test("it does not need a person to be signed in, and sets no cookie", async () => {
    const response = await get(
      { ARK_IOS_APP_ID: "ABCDE12345.com.example.ark" },
      "/.well-known/apple-app-site-association",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("telling the browser which Android app is Ark's own", () => {
  const capabilities = async (extra: Record<string, string>) =>
    (await (
      await createApp(loadConfig(testEnvironment(extra))).request(
        "http://openbot.local/api/capabilities",
      )
    ).json()) as { androidPackage: string | null };

  test("names the package where there is an Android app, and nothing else about it", async () => {
    const body = await capabilities({
      ARK_ANDROID_APP_ID: "com.example.ark",
      ARK_ANDROID_CERT_SHA256: FINGERPRINT,
    });
    expect(body.androidPackage).toBe("com.example.ark");
    // The key is for the verifier's file; the page has no use for it.
    expect(JSON.stringify(body)).not.toContain(FINGERPRINT);
  });

  test("says null where there is none, including when only an iOS app is named", async () => {
    expect((await capabilities({})).androidPackage).toBeNull();
    expect(
      (await capabilities({ ARK_IOS_APP_ID: "ABCDE12345.com.example.ark" }))
        .androidPackage,
    ).toBeNull();
  });
});
