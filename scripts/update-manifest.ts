#!/usr/bin/env bun
/**
 * Writes `update.json`, the file every installed ArkAgent reads to update itself (v0.1.57; Amgad,
 * 26 Nov 2026: "any installed app on any customer computer must get the updates we are releasing at
 * all times"). The release workflow runs it on the signed installers:
 *
 *   bun scripts/update-manifest.ts <installers folder> <version tag> <release base url> > update.json
 *
 * One entry per platform the release builds, each the file the app downloads and its signature (the
 * `.sig` Tauri writes beside it with BlackArk's update key). The address is the release's own folder
 * on the company site, where the release is uploaded: `<base>/<version>/<file name>`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type UpdateManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/** Which updater target a signed file is for, or null when it is not an update file. */
export function platformOf(file: string): string | null {
  const name = basename(file);
  if (name.endsWith(".app.tar.gz")) return "darwin-aarch64";
  if (/-setup\.exe$/i.test(name)) return "windows-x86_64";
  if (name.endsWith(".AppImage")) return "linux-x86_64";
  return null;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function buildManifest(input: {
  files: { path: string; signature: string }[];
  version: string;
  base: string;
  now?: Date;
}): UpdateManifest {
  const tag = input.version.startsWith("v")
    ? input.version
    : `v${input.version}`;
  const base = input.base.replace(/\/+$/, "");
  if (!base.startsWith("https://"))
    throw new Error("The release base must be an https address.");
  const platforms: UpdateManifest["platforms"] = {};
  for (const file of input.files) {
    const platform = platformOf(file.path);
    if (!platform) continue;
    if (platforms[platform])
      throw new Error(`Two update files for ${platform}.`);
    const signature = file.signature.trim();
    if (!signature)
      throw new Error(`${basename(file.path)} has an empty signature.`);
    platforms[platform] = {
      signature,
      url: `${base}/${tag}/${encodeURIComponent(basename(file.path))}`,
    };
  }
  if (Object.keys(platforms).length === 0)
    throw new Error("No signed update files were found.");
  return {
    version: tag.slice(1),
    notes: `ArkAgent ${tag}`,
    pub_date: (input.now ?? new Date()).toISOString(),
    platforms,
  };
}

if (import.meta.main) {
  const [dir, version, base] = process.argv.slice(2);
  if (!dir || !version || !base) {
    console.error(
      "Use: update-manifest.ts <installers folder> <version tag> <release base url>",
    );
    process.exit(2);
  }
  const files = walk(dir)
    .filter((path) => path.endsWith(".sig"))
    .map((sig) => ({
      path: sig.slice(0, -".sig".length),
      signature: readFileSync(sig, "utf8"),
    }));
  console.log(JSON.stringify(buildManifest({ files, version, base }), null, 2));
}
