/**
 * What the Android app is told about the deployment it belongs to, checked before anything is built.
 *
 * The app is a window onto one site, and nothing in the repository says which: the package name, the
 * address, the name on the home screen and the version all belong to a deployment the owner has yet to
 * choose (docs/ark/19-mobile.md), and a package name cannot be changed once it is published. So none
 * has a default, and a missing or wrong one stops the build here, in a sentence, instead of becoming a
 * Gradle error or an app that opens a browser tab with an address bar.
 *
 * Pure: the environment and the web manifest go in, the checked values come out. `prepare-android.ts`
 * reads the environment and writes the file Gradle reads.
 */
import { isAndroidAppId } from "../../server/src/mobile/links";
import {
  APP_NAME,
  APP_NAME_RULE,
  COLOUR,
  type Environment,
  need,
  siteFrom,
} from "./shared";

export { siteFrom };

export type AndroidConfig = {
  applicationId: string;
  /** The home-screen label. */
  appName: string;
  /** `https://host`, no path. */
  siteUrl: string;
  siteHost: string;
  themeColor: string;
  backgroundColor: string;
  versionCode: number;
  versionName: string;
};

/** What the web app's own manifest says about its colours. The app and the site look the same by construction. */
export type WebManifestColors = {
  theme_color?: string;
  background_color?: string;
};

const VERSION_NAME = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,20})?$/;

export function androidConfigFrom(
  environment: Environment,
  manifest: WebManifestColors,
  /** The repository's version, used when no version name is given. */
  defaultVersionName: string,
): AndroidConfig {
  const applicationId = need(environment, "ARK_ANDROID_APP_ID");
  if (!isAndroidAppId(applicationId)) {
    throw new Error(
      "ARK_ANDROID_APP_ID is not an Android package name (letters, digits and underscores in dotted parts, such as com.example.ark).",
    );
  }

  const appName = need(environment, "ARK_APP_NAME");
  if (!APP_NAME.test(appName)) {
    throw new Error(
      `ARK_APP_NAME is the name under the icon: ${APP_NAME_RULE}.`,
    );
  }

  const site = siteFrom(need(environment, "ARK_APP_URL"));

  const versionCodeText = need(environment, "ARK_ANDROID_VERSION_CODE");
  const versionCode = Number(versionCodeText);
  if (
    !/^\d+$/.test(versionCodeText) ||
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    // Play's ceiling.
    versionCode > 2_100_000_000
  ) {
    throw new Error(
      "ARK_ANDROID_VERSION_CODE is a whole number from 1 to 2100000000 that goes up with every release uploaded to Google Play.",
    );
  }

  const versionName =
    environment.ARK_ANDROID_VERSION_NAME?.trim() || defaultVersionName;
  if (!VERSION_NAME.test(versionName)) {
    throw new Error("ARK_ANDROID_VERSION_NAME is a version such as 1.4.0.");
  }

  const themeColor = manifest.theme_color ?? "";
  const backgroundColor = manifest.background_color ?? "";
  if (!COLOUR.test(themeColor) || !COLOUR.test(backgroundColor)) {
    throw new Error(
      "The web manifest (app/public/manifest.webmanifest) needs theme_color and background_color as #RRGGBB.",
    );
  }

  return {
    applicationId,
    appName,
    siteUrl: site.url,
    siteHost: site.host,
    themeColor: themeColor.toLowerCase(),
    backgroundColor: backgroundColor.toLowerCase(),
    versionCode,
    versionName,
  };
}

/**
 * The file Gradle reads. Every value was checked above to hold nothing a .properties file treats
 * specially (no backslash, no line break, no leading space), and none of it is a secret.
 */
export function propertiesFor(config: AndroidConfig): string {
  const lines = [
    "# Written by mobile/scripts/prepare-android.ts. Do not edit; do not commit.",
    `applicationId=${config.applicationId}`,
    `appName=${config.appName}`,
    `siteUrl=${config.siteUrl}`,
    `siteHost=${config.siteHost}`,
    `themeColor=${config.themeColor}`,
    `backgroundColor=${config.backgroundColor}`,
    `versionCode=${config.versionCode}`,
    `versionName=${config.versionName}`,
  ];
  return `${lines.join("\n")}\n`;
}
