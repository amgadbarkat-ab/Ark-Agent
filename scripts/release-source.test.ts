import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * The source archive the website serves is cut by a path list in `publish-release.yml`, and the
 * desktop app unpacks it using two lists in `deployment.rs`. They have to say the same thing: a path
 * the app needs and the archive leaves out is a customer whose first start fails after a long
 * download, and a path the archive carries and the app never reads is an internal document on a
 * public website.
 */
const root = new URL("..", import.meta.url);
const workflow = readFile(
  new URL(".github/workflows/publish-release.yml", root),
  "utf8",
);
const rust = readFile(
  new URL("desktop/src-tauri/src/deployment.rs", root),
  "utf8",
);

async function archivePaths(): Promise<string[]> {
  const text = await workflow;
  const match = text.match(
    /source\.tar "\$GITHUB_SHA" -- \\\n((?:\s+.*\\\n)*\s+.*)\n/,
  );
  if (!match) throw new Error("the git archive command was not found");
  return match[1]
    .split(/\\\n|\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

async function unpackedPaths(): Promise<string[]> {
  const text = await rust;
  const list = (name: string) => {
    const match = text.match(
      new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`),
    );
    if (!match) throw new Error(`${name} was not found`);
    // Comments inside the array are prose, and may quote things that are not entries.
    const entries = match[1].replace(/\/\/.*$/gm, "");
    return [...entries.matchAll(/"([^"]+)"/g)].map((word) => word[1]);
  };
  return [...list("REQUIRED"), ...list("ALSO_COPIED")];
}

describe("the source archive the website serves", () => {
  test("carries exactly what the desktop app unpacks", async () => {
    expect((await archivePaths()).sort()).toEqual(
      (await unpackedPaths()).sort(),
    );
  });

  test("carries only the legal documents from docs/", async () => {
    const underDocs = (await archivePaths()).filter(
      (path) => path === "docs" || path.startsWith("docs/"),
    );
    expect(underDocs).toEqual(["docs/legal"]);
  });

  test("has a manifest for every workspace the root manifest names", async () => {
    // `bun install --frozen-lockfile` stops with `Workspace not found "hub"` when a workspace listed
    // in package.json is absent from the tree, which is what the first real install of v0.1.0 did.
    const { workspaces } = JSON.parse(
      await readFile(new URL("package.json", root), "utf8"),
    ) as { workspaces: string[] };
    const paths = await archivePaths();
    for (const workspace of workspaces) {
      const carried = paths.some(
        (path) => path === workspace || path === `${workspace}/package.json`,
      );
      expect(
        carried,
        `${workspace} is a workspace but not in the archive`,
      ).toBe(true);
    }
  });

  test("the pre-built app's marker is the same word in the pipeline, the app and the desktop", async () => {
    const marker = ".openbot-prebuilt";
    const files = [
      ".github/workflows/publish-release.yml",
      "app/scripts/build-cache.ts",
      // The one definition on the desktop's side; the host start-up reads it from here.
      "desktop/src-tauri/src/deployment.rs",
    ];
    for (const file of files) {
      const text = await readFile(new URL(file, root), "utf8");
      expect(text, `${file} must name ${marker}`).toContain(marker);
    }
  });

  test("is cut under one top-level folder, which is the shape the app strips", async () => {
    expect(await workflow).toMatch(/--prefix="ark-\$\{VERSION\}\/"/);
  });

  test("names the newest version the way the app reads it", async () => {
    expect(await workflow).toContain("{tag_name: $tag}");
  });

  test("leaves the internal documents out", async () => {
    const paths = await archivePaths();
    for (const internal of ["docs", "brand", ".github", ".claude", "infra"]) {
      expect(paths).not.toContain(internal);
    }
  });
});
