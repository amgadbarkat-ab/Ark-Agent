import { describe, expect, test } from "bun:test";
import {
  fetchRelease,
  onlyTargets,
  pickLatest,
  type Release,
  pin,
  reportedDigest,
  selectAssets,
  sha256Hex,
  TARGETS,
} from "./pin-llama-runtime";

const encoder = new TextEncoder();

const NAMES = [
  "llama-b9628-bin-win-cpu-x64.zip",
  "llama-b9628-bin-win-cpu-arm64.zip",
  "llama-b9628-bin-win-vulkan-x64.zip",
  "llama-b9628-bin-win-cuda-12.4-x64.zip",
  "llama-b9628-bin-macos-arm64.tar.gz",
  "llama-b9628-bin-macos-x64.tar.gz",
  "llama-b9628-bin-ubuntu-x64.tar.gz",
  "llama-b9628-bin-ubuntu-vulkan-x64.tar.gz",
  "llama-b9628-bin-ubuntu-arm64.tar.gz",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
];

function bytesFor(name: string): Uint8Array {
  return encoder.encode(`contents of ${name}`);
}

function release(names = NAMES, digest = true): Release {
  return {
    tag_name: "b9628",
    assets: names.map((name) => ({
      name,
      size: bytesFor(name).byteLength,
      digest: digest ? `sha256:${sha256Hex(bytesFor(name))}` : null,
    })),
  };
}

/** Serves each asset's bytes at the release download address. */
function downloads(overrides: Record<string, Uint8Array> = {}) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const name = decodeURIComponent(url.split("/").pop() as string);
    const bytes = overrides[name] ?? bytesFor(name);
    return new Response(bytes);
  };
  return { fetchImpl, asked };
}

describe("choosing the files", () => {
  test("picks the CPU build for Windows, not Vulkan or CUDA, and the Metal build for Apple silicon", () => {
    const chosen = selectAssets(release());
    const byTarget = Object.fromEntries(
      chosen.map(({ target, asset }) => [
        `${target.os}/${target.arch}`,
        asset.name,
      ]),
    );
    expect(byTarget["windows/x86_64"]).toBe("llama-b9628-bin-win-cpu-x64.zip");
    expect(byTarget["windows/aarch64"]).toBe(
      "llama-b9628-bin-win-cpu-arm64.zip",
    );
    expect(byTarget["macos/aarch64"]).toBe(
      "llama-b9628-bin-macos-arm64.tar.gz",
    );
    expect(byTarget["linux/x86_64"]).toBe("llama-b9628-bin-ubuntu-x64.tar.gz");
    expect(chosen.length).toBe(TARGETS.length);
  });

  test("a missing asset stops the pin and says what was on offer", () => {
    const without = NAMES.filter((name) => !name.includes("macos-arm64"));
    expect(() => selectAssets(release(without))).toThrow(
      /macos\/aarch64.*Assets on offer: llama-b9628-bin-win-cpu-x64\.zip/s,
    );
  });

  test("two assets for one computer are refused, not guessed between", () => {
    const twice = [...NAMES, "llama-b9628-bin-win-cpu-x64.tar.gz"];
    expect(() => selectAssets(release(twice))).toThrow(
      /More than one asset matches windows\/x86_64/,
    );
  });

  test("reads only a well-formed sha256 digest", () => {
    const good = `sha256:${"a".repeat(64)}`;
    expect(reportedDigest({ name: "x", size: 1, digest: good })).toBe(
      "a".repeat(64),
    );
    expect(reportedDigest({ name: "x", size: 1, digest: "sha1:abc" })).toBe(
      undefined,
    );
    expect(reportedDigest({ name: "x", size: 1, digest: null })).toBe(
      undefined,
    );
    expect(
      reportedDigest({
        name: "x",
        size: 1,
        digest: `sha256:${"A".repeat(64)}`,
      }),
    ).toBe(undefined);
  });
});

describe("pinning", () => {
  test("hashes what it downloaded, not what it was told", async () => {
    const { fetchImpl, asked } = downloads();
    const manifest = await pin(release(), { fetchImpl });
    expect(manifest.tag).toBe("b9628");
    expect(manifest.source).toBe(
      "https://github.com/ggml-org/llama.cpp/releases/tag/b9628",
    );
    expect(manifest.assets.length).toBe(TARGETS.length);
    for (const asset of manifest.assets) {
      expect(asset.sha256).toBe(sha256Hex(bytesFor(asset.file)));
      expect(asset.size).toBe(bytesFor(asset.file).byteLength);
    }
    // Only the chosen files were fetched; Vulkan, CUDA and cudart were not.
    expect(asked.length).toBe(TARGETS.length);
    expect(
      asked.every((url) => url.includes("/releases/download/b9628/")),
    ).toBe(true);
    expect(asked.some((url) => url.includes("vulkan"))).toBe(false);
  });

  test("a file that does not hash to what GitHub reports stops everything", async () => {
    const name = "llama-b9628-bin-win-cpu-x64.zip";
    const original = bytesFor(name);
    // Same length, different bytes: the size check passes and only the digest can catch it.
    const tampered = new Uint8Array(original);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    const { fetchImpl } = downloads({ [name]: tampered });
    await expect(pin(release(), { fetchImpl })).rejects.toThrow(
      /hashes to .* GitHub reports/,
    );
  });

  test("a file of a different length than listed stops everything", async () => {
    const { fetchImpl } = downloads({
      "llama-b9628-bin-ubuntu-x64.tar.gz": encoder.encode("short"),
    });
    await expect(pin(release(), { fetchImpl })).rejects.toThrow(
      /downloaded 5 bytes, the release lists/,
    );
  });

  test("a failed download stops everything", async () => {
    const fetchImpl = async () => new Response("no", { status: 404 });
    await expect(pin(release(), { fetchImpl })).rejects.toThrow(/answered 404/);
  });

  test("--no-download takes GitHub's digests, and refuses a release that reports none", async () => {
    const manifest = await pin(release(), { download: false });
    expect(manifest.assets[0]?.sha256).toBe(
      sha256Hex(bytesFor(manifest.assets[0]?.file as string)),
    );
    await expect(
      pin(release(NAMES, false), { download: false }),
    ).rejects.toThrow(/reports no digest/);
  });
});

describe("one computer only", () => {
  test("pins just the asked-for kinds, and refuses a kind that does not exist", async () => {
    const { fetchImpl, asked } = downloads();
    const manifest = await pin(release(), {
      fetchImpl,
      targets: onlyTargets("linux/x86_64"),
    });
    expect(manifest.assets.map((a) => a.file)).toEqual([
      "llama-b9628-bin-ubuntu-x64.tar.gz",
    ]);
    expect(asked.length).toBe(1);
    expect(() => onlyTargets("plan9/riscv")).toThrow(/--only takes/);
  });
});

describe("reading the release", () => {
  test("a named tag is fetched by name, and a tag that could be a path is refused", async () => {
    const seen: string[] = [];
    const answer = (tag: string) => async (url: string) => {
      seen.push(url);
      return Response.json({ tag_name: tag, assets: [] });
    };
    await fetchRelease("b9628", { fetchImpl: answer("b9628") });
    expect(seen[0]).toEndWith("/releases/tags/b9628");
    await expect(
      fetchRelease("b9628", { fetchImpl: answer("../etc") }),
    ).rejects.toThrow(/Unexpected release tag/);
  });

  test("latest is the newest release that has the builds, not the one GitHub calls latest", async () => {
    // llama.cpp's real "latest" release was a marker holding one text file.
    const marker: Release = {
      tag_name: "v0.7.0",
      assets: [{ name: "nightly-tag.txt", size: 8 }],
    };
    const incomplete = release(NAMES.slice(0, 2));
    incomplete.tag_name = "b9630";
    const builds = release();
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return Response.json([marker, incomplete, builds]);
    };
    const chosen = await fetchRelease("latest", { fetchImpl });
    expect(chosen.tag_name).toBe("b9628");
    expect(seen[0]).toContain("/releases?per_page=");
  });

  test("latest for one computer accepts a release that lacks the others", () => {
    const partial = release(["llama-b9700-bin-ubuntu-x64.tar.gz"]);
    partial.tag_name = "b9700";
    expect(() => pickLatest([partial])).toThrow(/None of the 1 newest/);
    expect(pickLatest([partial], onlyTargets("linux/x86_64")).tag_name).toBe(
      "b9700",
    );
  });

  test("when nothing has the builds the error says what was seen", () => {
    expect(() => pickLatest([{ tag_name: "v0.7.0", assets: [] }])).toThrow(
      /Seen: v0\.7\.0 \(0 files\)/,
    );
  });

  test("an error status is an error", async () => {
    const fetchImpl = async () => new Response("rate limited", { status: 403 });
    await expect(fetchRelease("latest", { fetchImpl })).rejects.toThrow(/403/);
  });
});
