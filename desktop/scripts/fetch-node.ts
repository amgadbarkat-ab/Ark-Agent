#!/usr/bin/env bun
/**
 * Put the pinned Node inside the Windows installer (desk #85).
 *
 * Device control on Windows runs `agent-computer` under Node, because Bun on Windows cannot drive a
 * browser (own_browser.rs, `runs_on_node`). The owner chose to ship Node in the installer rather than
 * download it on a customer's PC, so the Windows build fetches it here, before `tauri build`, into
 * `src-tauri/node/`, which `tauri.windows-node.conf.json` adds to the installer's resources. The
 * desktop finds it there (`bundled_node`).
 *
 * The version and every byte are pinned in `node-runtime.json`, from nodejs.org's own SHASUMS256.txt
 * for that release. A file whose digest differs is refused and nothing is left behind, so a build
 * either ships exactly that Node or fails. Its licence ships beside it, as the MIT licence asks.
 *
 *   bun scripts/fetch-node.ts            # into src-tauri/node/
 *   bun scripts/fetch-node.ts --check    # verify what is already there, download nothing
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Pinned = { name: string; url: string; sha256: string };
type Manifest = { version: string; source: string; files: Pinned[] };

const root = join(import.meta.dir, "..", "src-tauri");
const manifest = JSON.parse(
  await readFile(join(root, "node-runtime.json"), "utf8"),
) as Manifest;
const into = join(root, "node");

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchVerified(file: Pinned): Promise<Uint8Array> {
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`${file.url} answered ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = digest(bytes);
  if (got !== file.sha256) {
    throw new Error(
      `${file.name} from ${file.url} has digest ${got}, not the pinned ${file.sha256}. Refusing to ship it.`,
    );
  }
  return bytes;
}

const checkOnly = process.argv.includes("--check");
await mkdir(into, { recursive: true });
try {
  for (const file of manifest.files) {
    const path = join(into, file.name);
    if (checkOnly) {
      if (!existsSync(path)) throw new Error(`${path} is missing.`);
      const got = digest(new Uint8Array(await readFile(path)));
      if (got !== file.sha256) {
        throw new Error(`${path} has digest ${got}, not ${file.sha256}.`);
      }
      continue;
    }
    await writeFile(path, await fetchVerified(file));
  }
} catch (error) {
  // Half a Node is worse than none: the desktop would find node.exe and run it without its licence,
  // or run a file that never matched. Nothing stays unless everything matched.
  if (!checkOnly) await rm(into, { recursive: true, force: true });
  throw error;
}
console.log(
  `Node ${manifest.version} ${checkOnly ? "verified" : "fetched and verified"} in ${into}`,
);
