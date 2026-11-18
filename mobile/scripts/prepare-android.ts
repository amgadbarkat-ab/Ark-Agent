/**
 * Check the deployment's names and write the file the Android build reads.
 *
 *   ARK_ANDROID_APP_ID=blackark.arkagent ARK_APP_URL=https://link.blackark.uk ARK_APP_NAME=ArkAgent \
 *   ARK_ANDROID_VERSION_CODE=1 bun mobile/scripts/prepare-android.ts
 *
 * ARK_APP_URL is the Ark Link host for BlackArk's app (#149); see android-config.ts.
 *
 * Nothing here is a secret. The signing key is read by Gradle from the environment and never written
 * anywhere (see mobile/README.md).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { androidConfigFrom, propertiesFor } from "./android-config";

const root = join(import.meta.dir, "..", "..");
const manifest = JSON.parse(
  readFileSync(join(root, "app", "public", "manifest.webmanifest"), "utf8"),
);
const repository = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { version?: string };

try {
  const config = androidConfigFrom(
    process.env,
    manifest,
    repository.version ?? "0.0.0",
  );
  writeFileSync(
    join(root, "mobile", "android", "ark.properties"),
    propertiesFor(config),
  );
  console.log(
    `Android build configured: ${config.applicationId} for ${config.siteUrl}, version ${config.versionName} (${config.versionCode}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
