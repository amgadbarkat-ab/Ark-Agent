import { readFileSync } from "node:fs";

/**
 * The release this server is part of, for the trial check-in: the root package.json, which the
 * release bumps together with the desktop app. "unknown" when it cannot be read.
 */
export function appVersion(): string {
  try {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof root.version === "string" ? root.version : "unknown";
  } catch {
    return "unknown";
  }
}
