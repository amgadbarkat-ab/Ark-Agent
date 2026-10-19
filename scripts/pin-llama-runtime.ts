#!/usr/bin/env bun
/**
 * Records which llama.cpp release the desktop app may download, and the SHA-256 of each file in it.
 *
 *   bun scripts/pin-llama-runtime.ts --tag latest --out desktop/src-tauri/llama-runtime.json
 *   bun scripts/pin-llama-runtime.ts --tag b9628 --out desktop/src-tauri/llama-runtime.json
 *
 * WHY A SCRIPT. The desktop's managed local model (docs/ark/22-starter-model.md) runs llama.cpp's
 * `llama-server`. Like Podman, Compose and Bun in install.rs, it is fetched by digest rather than by
 * name: a tag is what somebody hopes is there, a digest is what was run. The digests cannot be typed
 * from memory, and llama.cpp publishes a new build several times a day, so this reads them from the
 * release itself and writes the file the Rust code compiles in (`llama-runtime.json`).
 *
 * WHAT IT TRUSTS. The release is read from the GitHub API, then every file the desktop would use is
 * DOWNLOADED and hashed here, and the hash must equal the digest GitHub reports when it reports one.
 * A pin made without downloading would pin whatever the API said, and the point is to pin what was
 * run. A person reviews the resulting file in a commit before any customer receives it.
 *
 * WHICH FILES. One CPU build for each kind of computer we support, and for Windows on x86-64 the Vulkan
 * build as well: it drives NVIDIA, AMD and Intel Arc cards from the driver alone, so it needs no CUDA
 * toolkit, and the desktop tries it first on a computer with a card and falls back to the CPU build if it
 * will not start. macOS on Apple silicon gets the one build that uses the GPU through Metal. An asset that cannot be found fails the script rather than being skipped, so a
 * rename upstream is noticed here and not on a customer's computer.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export const REPOSITORY = "ggml-org/llama.cpp";

/** The kinds of computer the desktop app runs on, as Rust's `std::env::consts` names them. */
export type Target = {
  os: "windows" | "macos" | "linux";
  arch: "x86_64" | "aarch64";
  /** `cpu` by default; `metal` is the macOS build, and `vulkan` the Windows graphics-card build. */
  backend: "cpu" | "metal" | "vulkan";
  /** Matches the archive's file name. Extension varies between releases, so it is not fixed. */
  pattern: RegExp;
};

export const TARGETS: Target[] = [
  {
    os: "windows",
    arch: "x86_64",
    backend: "cpu",
    pattern: /^llama-[A-Za-z0-9.]+-bin-win-cpu-x64\.(zip|tar\.gz)$/,
  },
  {
    os: "windows",
    arch: "x86_64",
    backend: "vulkan",
    pattern: /^llama-[A-Za-z0-9.]+-bin-win-vulkan-x64\.(zip|tar\.gz)$/,
  },
  {
    os: "windows",
    arch: "aarch64",
    backend: "cpu",
    pattern: /^llama-[A-Za-z0-9.]+-bin-win-cpu-arm64\.(zip|tar\.gz)$/,
  },
  {
    os: "macos",
    arch: "aarch64",
    backend: "metal",
    pattern: /^llama-[A-Za-z0-9.]+-bin-macos-arm64\.(zip|tar\.gz)$/,
  },
  {
    os: "macos",
    arch: "x86_64",
    backend: "cpu",
    pattern: /^llama-[A-Za-z0-9.]+-bin-macos-x64\.(zip|tar\.gz)$/,
  },
  {
    os: "linux",
    arch: "x86_64",
    backend: "cpu",
    pattern: /^llama-[A-Za-z0-9.]+-bin-ubuntu-x64\.(zip|tar\.gz)$/,
  },
  {
    os: "linux",
    arch: "aarch64",
    backend: "cpu",
    pattern: /^llama-[A-Za-z0-9.]+-bin-ubuntu-arm64\.(zip|tar\.gz)$/,
  },
];

export type ReleaseAsset = {
  name: string;
  size: number;
  /** `sha256:<hex>` when GitHub reports one. */
  digest?: string | null;
};

export type Release = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export type PinnedAsset = {
  os: Target["os"];
  arch: Target["arch"];
  backend: Target["backend"];
  file: string;
  size: number;
  sha256: string;
};

export type Manifest = {
  tag: string;
  source: string;
  assets: PinnedAsset[];
};

/**
 * A release tag we are willing to put in a URL and a file name. llama.cpp tagged builds `b<number>` for
 * years and by October 2026 was tagging `v<major>.<minor>.<patch>`; either is accepted, anything with a
 * slash, space or quote is not.
 */
export function isBuildTag(tag: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._]{0,40}$/.test(tag);
}

/**
 * The asset for each target, or an error naming every target that has none and the names that were
 * on offer, so a rename upstream is a one-line fix to the pattern.
 */
export function selectAssets(
  release: Release,
  targets: Target[] = TARGETS,
): { target: Target; asset: ReleaseAsset }[] {
  const chosen: { target: Target; asset: ReleaseAsset }[] = [];
  const missing: Target[] = [];
  for (const target of targets) {
    const matches = release.assets.filter((asset) =>
      target.pattern.test(asset.name),
    );
    if (matches.length === 0) {
      missing.push(target);
      continue;
    }
    if (matches.length > 1) {
      throw new Error(
        `More than one asset matches ${target.os}/${target.arch}: ${matches.map((m) => m.name).join(", ")}`,
      );
    }
    chosen.push({ target, asset: matches[0] as ReleaseAsset });
  }
  if (missing.length > 0) {
    throw new Error(
      `No asset in ${release.tag_name} for ${missing.map((t) => `${t.os}/${t.arch}`).join(", ")}. ` +
        `Assets on offer: ${release.assets.map((a) => a.name).join(", ")}`,
    );
  }
  return chosen;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What GitHub reports for a file, as bare hex, or undefined when it reports nothing usable. */
export function reportedDigest(asset: ReleaseAsset): string | undefined {
  const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
  return match?.[1];
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function headers(token: string | undefined): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "ark-pin-llama-runtime",
  };
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

/**
 * The newest release that has a build for every computer asked for.
 *
 * "Latest release" is not the answer: llama.cpp's own latest-release marker pointed at `v0.7.0`, a
 * release holding a single `nightly-tag.txt`, while the builds sit under their own tags. So walk the
 * recent releases, newest first, and take the first with all the files.
 */
export function pickLatest(
  releases: Release[],
  targets: Target[] = TARGETS,
): Release {
  for (const release of releases) {
    if (!isBuildTag(release.tag_name)) continue;
    try {
      selectAssets(release, targets);
      return release;
    } catch {
      // Not this one: a marker release, or a build still being uploaded.
    }
  }
  throw new Error(
    `None of the ${releases.length} newest releases has a build for ${targets.map((t) => `${t.os}/${t.arch}`).join(", ")}. ` +
      `Seen: ${releases.map((r) => `${r.tag_name} (${r.assets.length} files)`).join(", ")}`,
  );
}

export async function fetchRelease(
  tag: string,
  options: {
    token?: string;
    fetchImpl?: Fetcher;
    targets?: Target[];
  } = {},
): Promise<Release> {
  const send = options.fetchImpl ?? fetch;
  if (tag === "latest") {
    const url = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
    const response = await send(url, { headers: headers(options.token) });
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for ${url}`);
    }
    const releases = (await response.json()) as (Release & {
      draft?: boolean;
    })[];
    return pickLatest(
      releases.filter((release) => !release.draft),
      options.targets,
    );
  }
  const url = `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await send(url, { headers: headers(options.token) });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${url}`);
  }
  const release = (await response.json()) as Release;
  if (!isBuildTag(release.tag_name)) {
    throw new Error(
      `Unexpected release tag "${release.tag_name}"; expected letters, digits, dots and underscores`,
    );
  }
  return release;
}

/**
 * Downloads each chosen file, hashes it, and checks it against GitHub's digest and size when they
 * are reported. A mismatch stops the whole pin: nothing is written from a release that disagrees
 * with itself.
 */
export async function pin(
  release: Release,
  options: {
    token?: string;
    fetchImpl?: Fetcher;
    download?: boolean;
    log?: (line: string) => void;
    targets?: Target[];
  } = {},
): Promise<Manifest> {
  const send = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const download = options.download ?? true;
  const assets: PinnedAsset[] = [];
  for (const { target, asset } of selectAssets(release, options.targets)) {
    const reported = reportedDigest(asset);
    let sha256: string;
    let size = asset.size;
    if (download) {
      const url = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${asset.name}`;
      log(`downloading ${asset.name}`);
      const response = await send(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status} for ${url}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      sha256 = sha256Hex(bytes);
      size = bytes.byteLength;
      if (size !== asset.size) {
        throw new Error(
          `${asset.name}: downloaded ${size} bytes, the release lists ${asset.size}`,
        );
      }
      if (reported && reported !== sha256) {
        throw new Error(
          `${asset.name}: downloaded file hashes to ${sha256}, GitHub reports ${reported}`,
        );
      }
    } else {
      if (!reported) {
        throw new Error(
          `${asset.name}: GitHub reports no digest, and --no-download was given`,
        );
      }
      sha256 = reported;
    }
    assets.push({
      os: target.os,
      arch: target.arch,
      backend: target.backend,
      file: asset.name,
      size,
      sha256,
    });
  }
  return {
    tag: release.tag_name,
    source: `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`,
    assets,
  };
}

/** `--only linux/x86_64`: one kind of computer, for a run that needs one file and not six. */
export function onlyTargets(spec: string): Target[] {
  const wanted = spec.split(",").map((part) => part.trim());
  const chosen = TARGETS.filter((target) =>
    wanted.includes(`${target.os}/${target.arch}`),
  );
  if (chosen.length !== wanted.length) {
    throw new Error(
      `--only takes os/arch pairs from: ${TARGETS.map((t) => `${t.os}/${t.arch}`).join(", ")}`,
    );
  }
  return chosen;
}

export function render(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(argv: string[]): Promise<void> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--no-download") flags.add("no-download");
    else if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      values.set(arg.slice(2), value);
      i += 1;
    } else throw new Error(`Unexpected argument ${arg}`);
  }
  const tag = values.get("tag") ?? "latest";
  const out = values.get("out");
  const only = values.get("only");
  const token = process.env.GITHUB_TOKEN || undefined;
  const targets = only ? onlyTargets(only) : undefined;
  const release = await fetchRelease(tag, { token, targets });
  // Always say what was on offer: a rename upstream is then visible in the log of a run that worked,
  // not only of one that failed.
  console.error(
    `Release ${release.tag_name}: ${release.assets.map((asset) => asset.name).join(", ")}`,
  );
  const manifest = await pin(release, {
    token,
    download: !flags.has("no-download"),
    log: (line) => console.error(line),
    targets,
  });
  const text = render(manifest);
  if (out) writeFileSync(out, text);
  // The text goes to the log too: a run on a hosted runner has no other way to hand it back to the
  // person who asked for it, short of an artifact.
  console.log(text);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
