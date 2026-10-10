import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The hub image installs with `--filter hub`, and a filtered install puts the hub's own dependencies
 * in `hub/node_modules`, not in the root `node_modules`. The runtime stage has to copy that folder, or
 * the image builds and then stops on its first line with `Cannot find package 'hono'`, which is what
 * the v0.1.1 release did on the first computer it ran on. CI also starts the built image
 * (`component dockerfiles`); this keeps the same mistake out of a pull request that does not run it.
 */
const dockerfile = readFileSync(
  join(import.meta.dir, "..", "hub", "Dockerfile"),
  "utf8",
);

test("the runtime stage carries the hub's own dependencies", () => {
  expect(dockerfile).toContain("--filter hub");
  expect(dockerfile).toMatch(
    /^COPY --from=deps \/app\/hub\/node_modules hub\/node_modules$/m,
  );
});

test("every package the hub imports at run time is a dependency of the hub", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "hub", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const name of ["hono", "postgres", "zod"]) {
    expect(
      manifest.dependencies[name],
      `${name} must be a dependency`,
    ).toBeDefined();
  }
});
