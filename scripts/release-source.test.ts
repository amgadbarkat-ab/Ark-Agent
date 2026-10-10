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
    /source\.tar\.gz "\$GITHUB_SHA" -- \\\n((?:\s+.*\\\n)*\s+.*)\n/,
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
    return [...match[1].matchAll(/"([^"]+)"/g)].map((word) => word[1]);
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
