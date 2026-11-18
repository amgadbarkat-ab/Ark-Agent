/**
 * The relay's two files: the installs BlackArk issued tokens to, and the device routes. Each holds
 * SHA-256 hashes only, written atomically with mode 600.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DeviceRoute, DeviceStore, Install } from "./relay";

const HEX64 = /^[0-9a-f]{64}$/;
export const INSTALL_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

function readJson<T>(file: string, key: string): T[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, T[]>;
  return Array.isArray(raw[key]) ? (raw[key] as T[]) : [];
}

function writeJson(file: string, key: string, value: unknown[]) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ [key]: value }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temp, file);
}

export function readInstalls(file: string): Install[] {
  return readJson<Install>(file, "installs").filter(
    (entry) => INSTALL_ID.test(entry.id) && HEX64.test(entry.tokenSha256),
  );
}

export function writeInstalls(file: string, installs: Install[]) {
  writeJson(file, "installs", installs);
}

/** Re-read when the file changes, so `installs.ts add` and `remove` apply without a restart. */
export function installsFromFile(file: string): () => Install[] {
  let cached: Install[] = [];
  let stamp = "";
  return () => {
    try {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (text !== stamp) {
        stamp = text;
        cached = readInstalls(file);
      }
    } catch {
      // Keep the last good list rather than drop every desktop on a half-written file.
    }
    return cached;
  };
}

export function deviceFileStore(file: string): DeviceStore {
  return {
    load: () =>
      readJson<DeviceRoute>(file, "devices").filter(
        (route) =>
          typeof route.id === "string" &&
          INSTALL_ID.test(route.installId) &&
          HEX64.test(route.tokenSha256),
      ),
    save: (routes) => writeJson(file, "devices", routes),
  };
}
