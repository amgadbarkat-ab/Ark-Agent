/**
 * What the iOS app is told about the deployment it belongs to, checked before anything is built, and
 * the two things done to the project Capacitor generates from it.
 *
 * Like the Android app, the iOS app is a window onto one site and nothing in the repository says
 * which: the bundle identifier, the site, the name under the icon and the address scheme the system
 * browser returns to all belong to a deployment the owner has yet to choose (docs/ark/19-mobile.md),
 * and none has a default. A missing or wrong one stops the build here, in a sentence.
 *
 * Pure: the environment goes in, checked values and edited text come out. `prepare-ios.ts` does the
 * reading, writing and running.
 */
import { isAppUrlScheme, isIosAppId } from "../../server/src/mobile/links";
import {
  APP_NAME,
  APP_NAME_RULE,
  type Environment,
  need,
  siteFrom,
} from "./shared";

export type IosConfig = {
  /** The Apple developer team that signs it. */
  teamId: string;
  bundleId: string;
  appName: string;
  siteUrl: string;
  siteHost: string;
  /** Where the system browser sends a person back to the app. */
  urlScheme: string;
  /** `CFBundleShortVersionString`: up to three whole numbers. */
  versionName: string;
  /** `CFBundleVersion`: a whole number that goes up with every upload to App Store Connect. */
  buildNumber: number;
};

/** What the app adds to the web view's user agent, so the site can tell it is inside the app. Must match `IOS_USER_AGENT_TOKEN` in the web app. */
export const USER_AGENT_TOKEN = "ArkStoreApp/ios";

const VERSION_NAME = /^\d+(\.\d+){0,2}$/;

export function iosConfigFrom(
  environment: Environment,
  /** The repository's version, used when no version name is given. */
  defaultVersionName: string,
): IosConfig {
  const appId = need(environment, "ARK_IOS_APP_ID");
  if (!isIosAppId(appId)) {
    throw new Error(
      "ARK_IOS_APP_ID is not an iOS app identifier: the ten-character team id, a dot, then the bundle identifier (such as ABCDE12345.com.example.ark).",
    );
  }
  const dot = appId.indexOf(".");
  const teamId = appId.slice(0, dot);
  const bundleId = appId.slice(dot + 1);

  const appName = need(environment, "ARK_APP_NAME");
  if (!APP_NAME.test(appName)) {
    throw new Error(
      `ARK_APP_NAME is the name under the icon: ${APP_NAME_RULE}.`,
    );
  }

  const site = siteFrom(need(environment, "ARK_APP_URL"));

  const urlScheme = need(environment, "ARK_IOS_URL_SCHEME");
  if (!isAppUrlScheme(urlScheme)) {
    throw new Error(
      "ARK_IOS_URL_SCHEME is not an app's own address scheme: three to thirty-two lowercase letters, digits, dots, plus signs or hyphens, starting with a letter, and not one the system already uses (such as https).",
    );
  }

  const buildText = need(environment, "ARK_IOS_BUILD_NUMBER");
  const buildNumber = Number(buildText);
  if (
    !/^\d+$/.test(buildText) ||
    !Number.isSafeInteger(buildNumber) ||
    buildNumber < 1 ||
    buildNumber > 2_000_000_000
  ) {
    throw new Error(
      "ARK_IOS_BUILD_NUMBER is a whole number from 1 to 2000000000 that goes up with every upload to App Store Connect.",
    );
  }

  const versionName =
    environment.ARK_IOS_VERSION_NAME?.trim() || defaultVersionName;
  if (!VERSION_NAME.test(versionName)) {
    throw new Error(
      "ARK_IOS_VERSION_NAME is up to three whole numbers separated by dots, such as 1.4.0 (the App Store accepts nothing else).",
    );
  }

  return {
    teamId,
    bundleId,
    appName,
    siteUrl: site.url,
    siteHost: site.host,
    urlScheme,
    versionName,
    buildNumber,
  };
}

/**
 * The file Capacitor reads to make the project.
 *
 * `server.url` is what makes the app a window onto the site: nothing of the web app is bundled, so
 * it is always the version the server is running. `allowNavigation` keeps the window on that site;
 * a link to anywhere else opens in the system browser instead of inside the app.
 */
export function capacitorConfigFor(config: IosConfig) {
  return {
    appId: config.bundleId,
    appName: config.appName,
    // Required to exist, and shown only if the site cannot be reached at all.
    webDir: "www",
    server: {
      url: config.siteUrl,
      cleartext: false,
      allowNavigation: [config.siteHost],
    },
    ios: {
      appendUserAgent: USER_AGENT_TOKEN,
      contentInset: "automatic",
    },
  };
}

const PLIST_END = /<\/dict>\s*<\/plist>\s*$/;

/**
 * Add to the generated Info.plist what Capacitor's template has no setting for:
 *
 *  - the address scheme, so the system browser can open the app again after signing in;
 *  - the export-compliance answer: the app uses only the encryption in the system's own HTTPS, which
 *    is exempt, and without this App Store Connect asks on every upload.
 *
 * Refuses a file that already has either key rather than adding a second one: an Info.plist with a
 * key twice is read by taking one of them, and which one is not something to leave to chance.
 */
export function patchInfoPlist(xml: string, config: IosConfig): string {
  for (const key of ["CFBundleURLTypes", "ITSAppUsesNonExemptEncryption"]) {
    if (xml.includes(`<key>${key}</key>`)) {
      throw new Error(`Info.plist already has ${key}; it was not edited.`);
    }
  }
  if (!PLIST_END.test(xml)) {
    throw new Error(
      "Info.plist is not in the shape expected; it was not edited.",
    );
  }
  const addition = [
    "\t<key>CFBundleURLTypes</key>",
    "\t<array>",
    "\t\t<dict>",
    "\t\t\t<key>CFBundleTypeRole</key>",
    "\t\t\t<string>Editor</string>",
    "\t\t\t<key>CFBundleURLName</key>",
    `\t\t\t<string>${config.bundleId}</string>`,
    "\t\t\t<key>CFBundleURLSchemes</key>",
    "\t\t\t<array>",
    `\t\t\t\t<string>${config.urlScheme}</string>`,
    "\t\t\t</array>",
    "\t\t</dict>",
    "\t</array>",
    "\t<key>ITSAppUsesNonExemptEncryption</key>",
    "\t<false/>",
    "",
  ].join("\n");
  return xml.replace(PLIST_END, (end) => `${addition}${end}`);
}

/** What `xcodebuild` is told so the version comes from the deployment, not from the generated project. */
export function versionSettings(config: IosConfig): string[] {
  return [
    `MARKETING_VERSION=${config.versionName}`,
    `CURRENT_PROJECT_VERSION=${config.buildNumber}`,
  ];
}

/**
 * Whether a file is the App Store's icon: a PNG of exactly 1024 by 1024 pixels with no transparency.
 * Returns what is wrong, or null. Read from the file's own header, so it needs nothing installed.
 */
export function iconProblem(bytes: Uint8Array): string | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 33 ||
    signature.some((byte, index) => bytes[index] !== byte)
  ) {
    return "is not a PNG file";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== 1024 || height !== 1024) {
    return `is ${width} by ${height} pixels, and the App Store wants 1024 by 1024`;
  }
  // Colour types 4 (grey) and 6 (colour) carry an alpha channel; the App Store refuses transparency.
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) {
    return "has a transparency channel, which the App Store refuses; save it without one";
  }
  // A palette image can still mark colours transparent, in a tRNS chunk.
  const text = new TextDecoder("latin1").decode(bytes);
  if (text.includes("tRNS")) {
    return "marks colours as transparent, which the App Store refuses; flatten it onto a solid background";
  }
  return null;
}
