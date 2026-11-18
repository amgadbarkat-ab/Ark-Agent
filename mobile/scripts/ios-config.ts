/**
 * What the iOS app is told, checked before anything is built, and the two things done to the project
 * Capacitor generates from it.
 *
 * The iOS app is one app for every customer (#149): a window onto Ark Link, the BlackArk relay a
 * customer's own desktop ArkAgent connects out to. A phone that is not paired yet is shown the pair
 * screen there; a paired one is shown its desktop's own app, through the relay. So the bundle
 * identifier is the product's (`blackark.arkagent`, the owner's choice, permanent once published) and
 * the start address is the Ark Link host, which is given at build time and has no default: a build
 * that silently pointed at a host nobody runs would look like a broken app.
 *
 * Pure: the environment goes in, checked values and edited text come out. `prepare-ios.ts` does the
 * reading, writing and running.
 */
import { isAppUrlScheme } from "../../server/src/mobile/links";
import {
  APP_NAME,
  APP_NAME_RULE,
  type Environment,
  need,
  siteFrom,
} from "./shared";

/** The app's bundle identifier. Permanent once published (docs/ark/20-accounts-and-keys.md). */
export const BUNDLE_ID = "blackark.arkagent";

const TEAM_ID = /^[A-Z0-9]{10}$/;

export type IosConfig = {
  bundleId: string;
  /** The Apple developer team that signs it; null for an unsigned build, which needs none. */
  teamId: string | null;
  appName: string;
  /** The Ark Link host the app opens, `https://host`. */
  linkUrl: string;
  linkHost: string;
  /**
   * Where the system browser sends a person back to the app after signing in, or null for none.
   *
   * The hand-off exists for a hosted deployment that signs in with Google, which refuses a web view
   * (server/src/auth/native-browser.ts). A desktop reached through Ark Link signs in inside the app,
   * so a build for Ark Link registers no scheme unless one is asked for.
   */
  urlScheme: string | null;
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
  const teamId = environment.ARK_IOS_TEAM_ID?.trim() || null;
  if (teamId !== null && !TEAM_ID.test(teamId)) {
    throw new Error(
      "ARK_IOS_TEAM_ID is the Apple developer team id: ten capital letters and digits, as App Store Connect shows it (such as ABCDE12345).",
    );
  }

  const appName = need(environment, "ARK_APP_NAME");
  if (!APP_NAME.test(appName)) {
    throw new Error(
      `ARK_APP_NAME is the name under the icon: ${APP_NAME_RULE}.`,
    );
  }

  const link = linkFrom(need(environment, "ARK_LINK_URL"));

  const urlScheme = environment.ARK_IOS_URL_SCHEME?.trim() || null;
  if (urlScheme !== null && !isAppUrlScheme(urlScheme)) {
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
    bundleId: BUNDLE_ID,
    teamId,
    appName,
    linkUrl: link.url,
    linkHost: link.host,
    urlScheme,
    versionName,
    buildNumber,
  };
}

/** The Ark Link host as an origin the app can open and stay on, or a sentence saying what it must be. */
function linkFrom(address: string): { url: string; host: string } {
  try {
    return siteFrom(address);
  } catch {
    throw new Error(
      "ARK_LINK_URL is the Ark Link host the app opens: https and a domain name, with no path, port, user name, query or fragment (such as https://link.blackark.uk).",
    );
  }
}

/**
 * The file Capacitor reads to make the project.
 *
 * `server.url` is what makes the app a window onto Ark Link: nothing of the web app is bundled, so
 * a paired phone always shows the version its desktop is running. `allowNavigation` keeps the window
 * on that host; a link to anywhere else opens in the system browser instead of inside the app.
 * `errorPath` shows the app's own page (`www/index.html`) when the host cannot be reached, instead of
 * a blank window.
 */
export function capacitorConfigFor(config: IosConfig) {
  return {
    appId: config.bundleId,
    appName: config.appName,
    // Required to exist; its page is shown when the host cannot be reached.
    webDir: "www",
    server: {
      url: config.linkUrl,
      cleartext: false,
      allowNavigation: [config.linkHost],
      errorPath: "index.html",
    },
    ios: {
      appendUserAgent: USER_AGENT_TOKEN,
      contentInset: "automatic",
    },
  };
}

const EMPTY_LINK = ' data-link=""';

/**
 * The app's own page (`www/index.html`, shown when the host cannot be reached) with the host its
 * "Try again" goes back to. The host is a checked origin, so it needs no escaping in an attribute.
 */
export function errorPageFor(html: string, config: IosConfig): string {
  if (html.split(EMPTY_LINK).length !== 2) {
    throw new Error(
      'www/index.html must have exactly one empty data-link="" for the Ark Link host; it was not edited.',
    );
  }
  return html.replace(EMPTY_LINK, ` data-link="${config.linkUrl}"`);
}

const PLIST_END = /<\/dict>\s*<\/plist>\s*$/;

/**
 * Add to the generated Info.plist what Capacitor's template has no setting for:
 *
 *  - the address scheme, when one is given, so the system browser can open the app again after
 *    signing in;
 *  - the export-compliance answer: the app uses only the encryption in the system's own HTTPS, which
 *    is exempt, and without this App Store Connect asks on every upload;
 *  - why it asks for the microphone and the camera. The desktop's pages ask for the microphone to
 *    dictate and to talk to an employee, and a file picker offers to take a photo; Capacitor's web
 *    view grants a page that, and iOS then ends the app on the spot if the reason is missing.
 *    English only: a Greek reason needs an `el.lproj/InfoPlist.strings` in the Xcode project.
 *
 * Refuses a file that already has any of these keys rather than adding a second one: an Info.plist
 * with a key twice is read by taking one of them, and which one is not something to leave to chance.
 */
export function patchInfoPlist(xml: string, config: IosConfig): string {
  for (const key of [
    "CFBundleURLTypes",
    "ITSAppUsesNonExemptEncryption",
    "NSMicrophoneUsageDescription",
    "NSCameraUsageDescription",
  ]) {
    if (xml.includes(`<key>${key}</key>`)) {
      throw new Error(`Info.plist already has ${key}; it was not edited.`);
    }
  }
  if (!PLIST_END.test(xml)) {
    throw new Error(
      "Info.plist is not in the shape expected; it was not edited.",
    );
  }
  const scheme = config.urlScheme
    ? [
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
      ]
    : [];
  const addition = [
    ...scheme,
    "\t<key>ITSAppUsesNonExemptEncryption</key>",
    "\t<false/>",
    "\t<key>NSMicrophoneUsageDescription</key>",
    "\t<string>ArkAgent uses the microphone when you dictate a message or talk to a digital employee.</string>",
    "\t<key>NSCameraUsageDescription</key>",
    "\t<string>ArkAgent uses the camera when you take a photo to attach to a message.</string>",
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
