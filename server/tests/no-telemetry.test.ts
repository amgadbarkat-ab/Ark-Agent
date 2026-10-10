import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("no telemetry", () => {
  test("importing the module switches the SDK's telemetry off, whatever the environment said", async () => {
    process.env.COPILOTKIT_TELEMETRY_DISABLED = "false";
    await import(`../src/no-telemetry?fresh=${Date.now()}`);
    expect(process.env.COPILOTKIT_TELEMETRY_DISABLED).toBe("true");
    expect(process.env.DO_NOT_TRACK).toBe("1");
  });

  test("the server loads it before anything else, so the SDK never sees telemetry on", () => {
    const entry = readFileSync(
      join(import.meta.dir, "../src/index.ts"),
      "utf8",
    );
    const firstImport = entry
      .split("\n")
      .find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "./no-telemetry";');
  });
});
