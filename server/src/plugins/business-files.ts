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
