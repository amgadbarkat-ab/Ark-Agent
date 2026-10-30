import { expect, test } from "bun:test";
import manifest from "../src-tauri/node-runtime.json";

// What fetch-node.ts ships inside the Windows installer (desk #85). Read here rather than through the
// script, which downloads when it runs.
test("the Node shipped for Windows is pinned to an official release, byte for byte", () => {
  // agent-computer's Node build needs 22 or newer (own-browser.yml checks the CI runner the same way).
  expect(Number(manifest.version.split(".")[0])).toBeGreaterThanOrEqual(22);
  expect(manifest.files.map((file) => file.name).sort()).toEqual([
    "LICENSE",
    "node.exe",
  ]);
  for (const file of manifest.files) {
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Only the Node project's own servers, at exactly this version.
    expect(
      file.url.startsWith(`https://nodejs.org/dist/v${manifest.version}/`) ||
        file.url.startsWith(
          `https://raw.githubusercontent.com/nodejs/node/v${manifest.version}/`,
        ),
    ).toBe(true);
  }
});
