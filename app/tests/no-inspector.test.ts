import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the SDK inspector", () => {
  test("stays switched off: it draws over the product and calls its vendor's servers", () => {
    const provider = readFileSync(
      join(import.meta.dir, "../src/lib/copilot/provider.tsx"),
      "utf8",
    );
    expect(provider).toContain("enableInspector={false}");
  });
});
