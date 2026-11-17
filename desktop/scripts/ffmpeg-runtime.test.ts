import { expect, test } from "bun:test";
import manifest from "../src-tauri/ffmpeg-runtime.json";
import windows from "../src-tauri/tauri.windows-node.conf.json";
import { publishedDigest } from "./fetch-ffmpeg";

test("the Windows installer ships a pinned LGPL FFmpeg with its licence and source note (#109)", () => {
  expect(manifest.archive.name).toContain("win64-lgpl");
  expect(manifest.archive.name).not.toContain("gpl-shared");
  expect(manifest.archive.name).not.toMatch(/-gpl[-.]/);
  expect(manifest.archive.url).toEndWith(`/${manifest.archive.name}`);
  expect(manifest.archive.sha256).toMatch(/^([0-9a-f]{64})?$/);
  const resources = windows.bundle.resources as Record<string, string>;
  for (const name of [
    "ffmpeg.exe",
    "ffprobe.exe",
    "LICENSE.txt",
    "SOURCE.txt",
  ]) {
    expect(resources[`ffmpeg/${name}`]).toBe(`ffmpeg/${name}`);
  }
});

test("BtbN's checksum list is read by file name", () => {
  const list = `${"a".repeat(64)}  other.zip\n${"b".repeat(64)}  ffmpeg-x-win64-lgpl.zip\n`;
  expect(publishedDigest(list, "ffmpeg-x-win64-lgpl.zip")).toBe("b".repeat(64));
  expect(publishedDigest(list, "missing.zip")).toBeNull();
});
