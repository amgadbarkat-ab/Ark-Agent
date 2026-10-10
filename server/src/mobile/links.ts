/**
 * What an Android or iOS app and this website say to each other so the system believes they belong
 * together.
 *
 * Android opens the website inside the app (with no address bar, and signed in as in the browser)
 * only when the site publishes a file naming the app's package and the fingerprint of the key that
 * signed it. iOS does the same with a file naming the team and bundle identifier. Both files are
 * public, hold no secret, and are only ever served when the operator has set the names; a deployment
 * with no store app serves neither, and says so with a plain 404 rather than the app's HTML (a
 * verifier that is handed HTML reads it as "not verified" and never says why).
 *
 * Pure: the names go in, the documents come out. `config.ts` checks the names, `app.ts` serves them.
 */

export type MobileLinksConfig = {
  android?: {
    /** The package name, such as `com.example.ark`. */
    appId: string;
    /** SHA-256 of each key the app may be signed with, as `AA:BB:…` (32 bytes). */
    certFingerprints: string[];
  };
  ios?: {
    /** `TEAMID.bundle.identifier`. */
    appId: string;
  };
};

const ANDROID_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const IOS_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export const isAndroidAppId = (value: string) =>
  value.length <= 255 && ANDROID_ID.test(value);

export const isIosAppId = (value: string) =>
  value.length <= 255 && IOS_ID.test(value);

/**
 * A certificate fingerprint in the form Android's file wants, or undefined if it is not one.
 *
 * Accepts what people copy out of the Play Console, a keytool listing or a script: upper or lower
 * case, with or without the colons. Anything that is not exactly 32 bytes of hex is refused, because
 * a truncated fingerprint would be published as if it were the whole key and verification would fail
 * with nothing pointing at why.
 */
export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.trim().replaceAll(":", "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return undefined;
  return (hex.match(/.{2}/g) as string[]).join(":");
}

/** `/.well-known/assetlinks.json`: this site may be opened by the app, which holds the key listed. */
export function assetLinks(android: NonNullable<MobileLinksConfig["android"]>) {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: android.appId,
        sha256_cert_fingerprints: android.certFingerprints,
      },
    },
  ];
}

/**
 * `/.well-known/apple-app-site-association`: links into this site open the app, except the API,
 * which is never a page and must stay in whatever made the request.
 */
export function appleAppSiteAssociation(
  ios: NonNullable<MobileLinksConfig["ios"]>,
) {
  return {
    applinks: {
      details: [
        {
          appIDs: [ios.appId],
          components: [{ "/": "/api/*", exclude: true }, { "/": "*" }],
        },
      ],
    },
    webcredentials: { apps: [ios.appId] },
  };
}

/**
 * Schemes that mean something to a browser or the system, and so can never be an app's own.
 *
 * The scheme is where the system browser sends a person back to the app after signing in. If it were
 * `https` it would be an open redirect, and `javascript:` would be a script; the others open other
 * programs. An app's own scheme is a name nobody else has any reason to use.
 */
const RESERVED_SCHEMES = new Set([
  "http",
  "https",
  "file",
  "ftp",
  "ws",
  "wss",
  "data",
  "javascript",
  "vbscript",
  "blob",
  "about",
  "mailto",
  "tel",
  "sms",
  "facetime",
  "intent",
  "chrome",
  "safari",
  "itms",
  "itms-apps",
  "maps",
  "webcal",
  "view-source",
]);

/** The custom address scheme an app is opened by (`name://…`), at least three characters. */
export const isAppUrlScheme = (value: string) =>
  /^[a-z][a-z0-9+.-]{2,31}$/.test(value) && !RESERVED_SCHEMES.has(value);
