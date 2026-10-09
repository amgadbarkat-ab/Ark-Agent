/**
 * Check the deployment's names, make the Xcode project for the iOS app, and set it up.
 *
 *   ARK_IOS_APP_ID=ABCDE12345.com.example.ark ARK_APP_URL=https://ark.example ARK_APP_NAME=Ark \
 *   ARK_IOS_URL_SCHEME=arkapp ARK_IOS_BUILD_NUMBER=1 bun mobile/scripts/prepare-ios.ts
 *
 * Runs anywhere (Capacitor's CLI makes the project without Xcode); building it needs a Mac. Starts
 * the project afresh each time, so nothing from an earlier deployment's names can be left in it.
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
  capacitorConfigFor,
  iconProblem,
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
    { cwd: shell, stdout: "inherit", stderr: "inherit" },
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
    `iOS project made: ${config.bundleId} for ${config.siteUrl}, version ${config.versionName} (${config.buildNumber}), team ${config.teamId}.`,
  );
  for (const setting of versionSettings(config)) console.log(setting);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
