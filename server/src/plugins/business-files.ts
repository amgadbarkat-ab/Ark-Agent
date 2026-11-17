/**
 * The business's own data files (#109, v0.1.43): exports from its ERP, such as Pylon's items, stock,
 * sales and customer lists, or any other table it keeps. For every install.
 *
 * An administrator uploads each file in Settings under a short name ("stock", "customers"). The
 * employees granted this tool can list the files and find rows in them, exactly as written. Nothing
 * here reaches outside this deployment, and nothing is changed: a new export replaces the old one.
 */
import { eq } from "drizzle-orm";
import { cutAtCodeUnits } from "../channels/text";
import type { Database } from "../db/client";
import { businessFiles } from "../db/schema";
import { answer } from "./business-http";
import type { McpCallResult, McpTool } from "./mcp";
import {
  matchingRows,
  PriceListRefusedError,
  priceRowsFrom,
} from "./price-list";

export const MAX_BUSINESS_FILES = 20;
const MAX_MATCHES = 40;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type BusinessFileView = {
  name: string;
  fileName: string;
  uploadedAt: string;
  rows: number;
  header: string;
};

export class BusinessFileRefusedError extends Error {}

let database: Database | null = null;

/** Wired once at start (index.ts). */
export function useBusinessFilesDatabase(value: Database | null): void {
  database = value;
}

export async function listBusinessFiles(): Promise<BusinessFileView[]> {
  if (!database) return [];
  const rows = await database.select().from(businessFiles);
  return rows
    .map((row) => ({
      name: row.name,
      fileName: row.fileName,
      uploadedAt: row.uploadedAt.toISOString(),
      rows: row.rows.length,
      header: row.header,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveBusinessFile(input: {
  name: string;
  fileName: string;
  bytes: Uint8Array;
  by: string | null;
}): Promise<BusinessFileView> {
  if (!database) throw new BusinessFileRefusedError("No database.");
  const name = input.name.trim().toLowerCase();
  if (!NAME.test(name)) {
    throw new BusinessFileRefusedError(
      "Give the file a short name in lower-case letters, numbers and hyphens, for example stock or customers.",
    );
  }
  const existing = await listBusinessFiles();
  if (
    !existing.some((file) => file.name === name) &&
    existing.length >= MAX_BUSINESS_FILES
  ) {
    throw new BusinessFileRefusedError(
      `There can be up to ${MAX_BUSINESS_FILES} data files. Remove one first.`,
    );
  }
  const fileName = input.fileName.trim().slice(0, 200) || name;
  let read: { header: string; rows: string[] };
  try {
    read = priceRowsFrom(fileName, input.bytes);
  } catch (error) {
    throw new BusinessFileRefusedError(
      error instanceof PriceListRefusedError
        ? error.message
        : "The file could not be read.",
    );
  }
  const values = {
    name,
    fileName,
    header: read.header,
    rows: read.rows,
    uploadedBy: input.by,
    uploadedAt: new Date(),
  };
  await database
    .insert(businessFiles)
    .values(values)
    .onConflictDoUpdate({ target: businessFiles.name, set: values });
  const saved = (await listBusinessFiles()).find((file) => file.name === name);
  if (!saved) throw new Error("The data file was not stored.");
  return saved;
}

export async function removeBusinessFile(name: string): Promise<void> {
  if (!database) return;
  await database.delete(businessFiles).where(eq(businessFiles.name, name));
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_data_files",
    description:
      "The business's own data files uploaded in Settings (for example exports from Pylon: items, stock, sales, customers), with their column headers and when each was uploaded.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_rows",
    description:
      "Find rows in one of the business's data files, exactly as written there. Use the file's name from list_data_files. Say how old the file is when it matters, for stock in particular.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "The data file's name." },
        query: {
          type: "string",
          description: "Words or a code to look for in the rows.",
        },
      },
      required: ["file", "query"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export async function callTool(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const files = await listBusinessFiles();
  if (toolName === "list_data_files") {
    if (files.length === 0) {
      return answer(
        "No data files are uploaded yet. Say so, and do not guess stock, items or sales.",
      );
    }
    return answer(
      files
        .map(
          (file) =>
            `${file.name}: ${file.fileName}, ${file.rows} rows, uploaded ${file.uploadedAt.slice(0, 10)}. Columns: ${cutAtCodeUnits(file.header, 300)}`,
        )
        .join("\n"),
    );
  }
  if (toolName !== "find_rows") {
    return answer(`There is no data-file tool called ${toolName}.`, true);
  }
  const name =
    typeof args.file === "string" ? args.file.trim().toLowerCase() : "";
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 200) {
    return answer("Say what to look for, in up to 200 characters.", true);
  }
  if (!database || !files.some((file) => file.name === name)) {
    return answer(
      files.length === 0
        ? "No data files are uploaded yet."
        : `There is no data file called “${name}”. The files are: ${files.map((file) => file.name).join(", ")}.`,
      true,
    );
  }
  const [row] = await database
    .select()
    .from(businessFiles)
    .where(eq(businessFiles.name, name));
  if (!row) return answer(`There is no data file called “${name}”.`, true);
  const found = matchingRows(row.rows, query);
  if (found.length === 0) {
    return answer(
      `Nothing in ${name} (${row.fileName}) matches “${query}”. Try other words or the code.`,
    );
  }
  const shown = found.slice(0, MAX_MATCHES);
  return answer(
    [
      `From ${name} (${row.fileName}), uploaded ${row.uploadedAt.toISOString().slice(0, 10)}. Quote values exactly as written.`,
      row.header,
      ...shown,
      ...(found.length > shown.length
        ? [`… and ${found.length - shown.length} more rows. Narrow it down.`]
        : []),
    ].join("\n"),
  );
}

// ---- the watched folder (v0.1.45) -------------------------------------------------------------

/**
 * A file name as a data file's name: «Stock Export.xlsx» → "stock-export". Null when nothing usable
 * is left, so a file named only in Greek letters is skipped rather than imported under a guess.
 */
export function nameFromFile(fileName: string): string | null {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const name = stem
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return NAME.test(name) ? name : null;
}

let watchedFolder: string | null = null;

/** Where exports are picked up from on this install, or null where there is none. */
export function businessFolder(): string | null {
  return watchedFolder;
}

/**
 * Imports each CSV/XLSX in `dir` that is new or changed since it was last imported, under the name
 * its file name gives (`stock.xlsx` → `stock`), replacing the older one. The business's ERP (Pylon,
 * for example) saves its exports there, so the data is as fresh as the last export with no upload by
 * hand. One pass; `startBusinessFolderWatch` runs it every minute.
 */
export async function importBusinessFolder(dir: string): Promise<string[]> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const known = new Map(
    (await listBusinessFiles()).map((file) => [
      file.name,
      Date.parse(file.uploadedAt),
    ]),
  );
  const imported: string[] = [];
  for (const entry of entries.sort()) {
    if (!/\.(csv|xlsx|txt)$/i.test(entry) || entry.startsWith("~$")) continue;
    const name = nameFromFile(entry);
    if (!name) continue;
    const path = join(dir, entry);
    let modified: number;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      modified = info.mtimeMs;
    } catch {
      continue;
    }
    const last = known.get(name);
    if (last !== undefined && last >= modified) continue;
    try {
      await saveBusinessFile({
        name,
        fileName: entry,
        bytes: new Uint8Array(await readFile(path)),
        by: null,
      });
      imported.push(name);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "business-folder-skipped",
          file: entry,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return imported;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function startBusinessFolderWatch(dir: string): () => void {
  watchedFolder = dir;
  void import("node:fs/promises").then(({ mkdir }) =>
    mkdir(dir, { recursive: true }).catch(() => undefined),
  );
  const tick = () => {
    void importBusinessFolder(dir).catch(() => undefined);
  };
  const first = setTimeout(tick, 5_000);
  const every = setInterval(tick, 60_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
    watchedFolder = null;
  };
}
