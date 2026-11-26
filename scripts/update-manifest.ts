#!/usr/bin/env bun
/**
 * Writes `update.json`, the file every installed ArkAgent reads to update itself (v0.1.57; Amgad,
 * 26 Nov 2026: "any installed app on any customer computer must get the updates we are releasing at
 * all times"). The release workflow runs it once the update files are signed:
 *
 *   bun scripts/update-manifest.ts <installers folder> <signatures folder> <version tag> <release base url> > update.json
 *
 * One entry per kind of install the release builds, each the file the app downloads and its signature
 * (`<file name>.sig`, made with BlackArk's update key in the release's `sign-updates` job). The
 * address is the release's own folder on the company site, where the release is uploaded:
 * `<base>/<version>/<file name>`, with `update.json` itself at `<base>/update.json`.
 *
 * After the release folder is on the site, the same script checks that every address answers:
 *
 *   bun scripts/update-manifest.ts check <release base url>
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type UpdateManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/**
 * Which updater target a file is for, or null when it is not an update file. The updater looks for
 * `<os>-<arch>-<kind of install>` first and `<os>-<arch>` second, so a .deb or .rpm install finds
 * its own package and the AppImage keeps the plain Linux entry (security review U2).
 */
export function platformOf(file: string): string | null {
  const name = basename(file);
  if (name.endsWith(".app.tar.gz")) return "darwin-aarch64";
  if (/-setup\.exe$/i.test(name)) return "windows-x86_64";
  if (name.endsWith(".AppImage")) return "linux-x86_64";
  if (name.endsWith(".deb")) return "linux-x86_64-deb";
  if (name.endsWith(".rpm")) return "linux-x86_64-rpm";
  return null;
}

/**
 * A file name that reads the same on a release page, on the site and in a URL (security review
 * U4: GitHub turns spaces into dots, so a name that needs escaping would point at nothing).
 */
export function plainName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
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
    const name = basename(file.path);
    if (!plainName(name))
      throw new Error(`${name} is not a plain file name for an address.`);
    if (platforms[platform])
      throw new Error(`Two update files for ${platform}.`);
    const signature = file.signature.trim();
    if (!signature) throw new Error(`${name} has an empty signature.`);
    platforms[platform] = { signature, url: `${base}/${tag}/${name}` };
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

/** Every update file in the installers folder, with its signature from the signatures folder. */
export function signedFiles(
  installers: string,
  signatures: string,
): { path: string; signature: string }[] {
  return walk(installers)
    .filter((path) => platformOf(path) !== null)
    .map((path) => {
      const sig = join(signatures, `${basename(path)}.sig`);
      if (!existsSync(sig))
        throw new Error(`${basename(path)} was not signed.`);
      return { path, signature: readFileSync(sig, "utf8") };
    });
}

/**
 * What is missing on the site: `update.json` at the base, and each file it names. Empty when every
 * installed app can update from it. Only reads.
 */
export async function checkSite(
  base: string,
  get: (url: string, method: "GET" | "HEAD") => Promise<Response> = (
    url,
    method,
  ) => fetch(url, { method }),
): Promise<string[]> {
  const root = base.replace(/\/+$/, "");
  const at = `${root}/update.json`;
  const response = await get(at, "GET").catch(() => null);
  if (!response?.ok) return [`${at} does not answer`];
  let manifest: UpdateManifest;
  try {
    manifest = (await response.json()) as UpdateManifest;
  } catch {
    return [`${at} is not JSON`];
  }
  const problems: string[] = [];
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    if (!entry.url.startsWith(`${root}/v${manifest.version}/`))
      problems.push(`${platform}: ${entry.url} is not in v${manifest.version}`);
    const file = await get(entry.url, "HEAD").catch(() => null);
    if (!file?.ok) problems.push(`${platform}: ${entry.url} does not answer`);
  }
  return problems;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "check" && args[1]) {
    const problems = await checkSite(args[1]);
    for (const problem of problems) console.error(problem);
    console.log(
      problems.length === 0
        ? "Every installed app can update from this site."
        : "Not ready.",
    );
    process.exit(problems.length === 0 ? 0 : 1);
  }
  const [installers, signatures, version, base] = args;
  if (!installers || !signatures || !version || !base) {
    console.error(
      "Use: update-manifest.ts <installers folder> <signatures folder> <version tag> <release base url>\n" +
        "  or update-manifest.ts check <release base url>",
    );
    process.exit(2);
  }
  const files = signedFiles(installers, signatures);
  console.log(JSON.stringify(buildManifest({ files, version, base }), null, 2));
}
