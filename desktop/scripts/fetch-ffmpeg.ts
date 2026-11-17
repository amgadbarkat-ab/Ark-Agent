#!/usr/bin/env bun
/**
 * Put a pinned LGPL FFmpeg inside the Windows installer (#109, v0.1.44), as `fetch-node.ts` does for
 * Node: video editing then works on a customer's PC with nothing else to install.
 *
 * WHICH BUILD. BtbN's `win64-lgpl` build: FFmpeg with only LGPL parts (no x264, no GPL filters), so
 * shipping it beside ArkAgent needs only its licence and a pointer to its source, both put next to
 * it. On Windows it encodes H.264 with Windows' own Media Foundation encoder (`h264_mf`), which
 * `video.ts` picks when x264 is absent.
 *
 * PINNED. The archive is checked against the SHA-256 in `ffmpeg-runtime.json`. While that pin is
 * empty (the first build of a new version), the archive must match BtbN's own `checksums.sha256`
 * for that release, and the digest is printed so it can be pinned; the build then ships exactly that
 * file. Anything else is refused and nothing is left behind.
 *
 *   bun scripts/fetch-ffmpeg.ts      # into src-tauri/ffmpeg/
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type Manifest = {
  version: string;
  licence: string;
  release: string;
  archive: { name: string; url: string; sha256: string };
  checksums: string;
  source: string;
  files: string[];
};

const root = join(import.meta.dir, "..", "src-tauri");
const manifest = JSON.parse(
  await readFile(join(root, "ffmpeg-runtime.json"), "utf8"),
) as Manifest;
const into = join(root, "ffmpeg");

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The digest BtbN published for this file in the same release, or null. */
export function publishedDigest(list: string, name: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && hash && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return null;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

if (import.meta.main) {
  const work = await mkdtemp(join(tmpdir(), "ark-ffmpeg-"));
  try {
    const bytes = await download(manifest.archive.url);
    const got = digest(bytes);
    if (manifest.archive.sha256) {
      if (got !== manifest.archive.sha256) {
        throw new Error(
          `${manifest.archive.name} has digest ${got}, not the pinned ${manifest.archive.sha256}. Refusing to ship it.`,
        );
      }
    } else {
      const published = publishedDigest(
        new TextDecoder().decode(await download(manifest.checksums)),
        manifest.archive.name,
      );
      if (published !== got) {
        throw new Error(
          `${manifest.archive.name} has digest ${got}, but its release publishes ${published ?? "none"}. Refusing to ship it.`,
        );
      }
      console.log(`PIN ffmpeg-runtime.json archive.sha256: ${got}`);
    }
    const zip = join(work, manifest.archive.name);
    await writeFile(zip, bytes);
    // bsdtar, on every Windows runner since 2018, reads zip archives.
    const unpack = Bun.spawnSync(["tar", "-xf", zip, "-C", work]);
    if (unpack.exitCode !== 0) {
      throw new Error(`Could not unpack ${zip}: ${unpack.stderr.toString()}`);
    }
    const top = (await readdir(work, { withFileTypes: true })).find((entry) =>
      entry.isDirectory(),
    );
    if (!top) throw new Error("The archive has no folder inside.");
    await rm(into, { recursive: true, force: true });
    await mkdir(into, { recursive: true });
    for (const file of manifest.files) {
      const from = join(work, top.name, file);
      if (!existsSync(from)) throw new Error(`The archive has no ${file}.`);
      await copyFile(from, join(into, basename(file)));
    }
    await writeFile(
      join(into, "SOURCE.txt"),
      [
        `FFmpeg ${manifest.version}, ${manifest.licence}.`,
        `Built by BtbN/FFmpeg-Builds: ${manifest.release}`,
        `Archive: ${manifest.archive.name}, SHA-256 ${got}`,
        `Source code: ${manifest.source}`,
        "ArkAgent runs these programs unchanged, as separate programs, for video editing on this computer.",
        "",
      ].join("\r\n"),
    );
    console.log(`FFmpeg ${manifest.version} fetched and verified in ${into}`);
  } catch (error) {
    await rm(into, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
