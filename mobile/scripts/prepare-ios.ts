/**
 * Check the names a build is given, make the Xcode project for the iOS app, and set it up.
 *
 *   ARK_LINK_URL=https://link.blackark.uk ARK_APP_NAME=ArkAgent ARK_IOS_BUILD_NUMBER=1 \
 *   bun mobile/scripts/prepare-ios.ts
 *
 * `ARK_IOS_TEAM_ID` is only needed to sign; `ARK_IOS_URL_SCHEME` only for the system-browser sign-in
 * of a hosted deployment (ios-config.ts).
 *
 * Runs anywhere (Capacitor's CLI makes the project without Xcode); building it needs a Mac. Starts
 * the project afresh each time, so nothing from an earlier build's names can be left in it.
 * Nothing here is a secret. Prints the version settings `xcodebuild` is given, one per line.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  APP_LANGUAGES,
  addLocalizedInfoPlist,
  capacitorConfigFor,
  errorPageFor,
  iconProblem,
  infoPlistStrings,
  iosConfigFrom,
  patchInfoPlist,
  versionSettings,
} from "./ios-config";

const root = join(import.meta.dir, "..", "..");
const shell = join(root, "mobile", "ios");
const repository = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as {
  version?: string;
};

function run(args: string[]) {
  const result = Bun.spawnSync(
    [
      "bun",
      join(shell, "node_modules", "@capacitor", "cli", "bin", "capacitor"),
      ...args,
    ],
    // Capacitor prints its progress ("✔ Adding native Xcode project ...") to stdout, and this script's
    // own stdout is the list of build settings the workflow hands to xcodebuild. Sent to stderr, the
    // progress is still shown and is no longer taken for a build action ("Unknown build action").
    { cwd: shell, stdout: 2, stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `capacitor ${args.join(" ")} failed (exit ${result.exitCode}).`,
    );
  }
}

try {
  if (!existsSync(join(shell, "node_modules", "@capacitor", "cli"))) {
    throw new Error("Run `bun install` in mobile/ios first.");
  }
  const config = iosConfigFrom(process.env, repository.version ?? "0.0.0");

  // The icon is the owner's brand asset and is checked before anything is made.
  const brandIcon = join(shell, "brand", "AppIcon-1024.png");
  const hasIcon = existsSync(brandIcon);
  if (hasIcon) {
    const problem = iconProblem(readFileSync(brandIcon));
    if (problem)
      throw new Error(`mobile/ios/brand/AppIcon-1024.png ${problem}.`);
  }

  rmSync(join(shell, "ios"), { recursive: true, force: true });
  writeFileSync(
    join(shell, "capacitor.config.json"),
    `${JSON.stringify(capacitorConfigFor(config), null, 2)}\n`,
  );
  run(["add", "ios"]);
  run(["sync", "ios"]);

  const plist = join(shell, "ios", "App", "App", "Info.plist");
  writeFileSync(plist, patchInfoPlist(readFileSync(plist, "utf8"), config));

  // Why it asks for the microphone and camera, in each language, and the project told about them.
  for (const language of APP_LANGUAGES) {
    const folder = join(shell, "ios", "App", "App", `${language}.lproj`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "InfoPlist.strings"),
      infoPlistStrings(language),
    );
  }
  const project = join(shell, "ios", "App", "App.xcodeproj", "project.pbxproj");
  writeFileSync(project, addLocalizedInfoPlist(readFileSync(project, "utf8")));

  // The copy inside the project, not www/ itself, which stays the same for every build.
  const page = join(shell, "ios", "App", "App", "public", "index.html");
  writeFileSync(page, errorPageFor(readFileSync(page, "utf8"), config));

  if (hasIcon) {
    const icons = join(
      shell,
      "ios",
      "App",
      "App",
      "Assets.xcassets",
      "AppIcon.appiconset",
    );
    mkdirSync(icons, { recursive: true });
    copyFileSync(brandIcon, join(icons, "AppIcon-512@2x.png"));
  } else {
    console.warn(
      "mobile/ios/brand/AppIcon-1024.png is missing: the app has Capacitor's placeholder icon, which the App Store refuses.",
    );
  }

  console.error(
    `iOS project made: ${config.bundleId} opening ${config.linkUrl}, version ${config.versionName} (${config.buildNumber}), ${config.teamId ? `team ${config.teamId}` : "no team (unsigned)"}.`,
  );
  for (const setting of versionSettings(config)) console.log(setting);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
