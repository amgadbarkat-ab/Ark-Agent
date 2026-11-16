/**
 * The business's own price list (#109, MD 15 Nov: the business adds it after setup).
 *
 * An administrator uploads a CSV or XLSX in Settings, then Price list. Its rows are kept as the text
 * they were written with, one line per row, under the header row. The employees the trial profile
 * marks `priceList` get one tool, `find_price`, which returns the rows matching what was asked,
 * exactly as written, and nothing it did not find. Until a list is uploaded, the tool says the
 * prices are not loaded, so an employee says so rather than guesses.
 *
 * Nothing here reaches outside this deployment: the list lives in its database, and the tool reads
 * it from there.
 */
import { eq } from "drizzle-orm";
import {
  officeKindOf,
  UnreadableDocument,
  xlsxText,
} from "../channels/office-text";
import { cutAtCodeUnits } from "../channels/text";
import type { Database } from "../db/client";
import { priceList } from "../db/schema";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

export const MAX_PRICE_LIST_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_LINE = 1000;
const MAX_MATCHES = 30;
const LIST_ID = "list";

/** What an employee says, in Greek first, when there is no list yet. */
export const NOT_LOADED =
  "Οι τιμές δεν έχουν φορτωθεί ακόμη (prices are not loaded yet). Do not give a price: say the price list has not been loaded yet, and offer to have a person reply.";

export class PriceListRefusedError extends Error {}

export type PriceListView = {
  fileName: string;
  uploadedAt: string;
  rows: number;
  header: string;
};

/** The rows of a CSV or XLSX, as lines of text, the header first. */
export function priceRowsFrom(
  fileName: string,
  bytes: Uint8Array,
): { header: string; rows: string[] } {
  if (bytes.byteLength === 0)
    throw new PriceListRefusedError("The file is empty.");
  if (bytes.byteLength > MAX_PRICE_LIST_BYTES) {
    throw new PriceListRefusedError("The file is larger than 8 MB.");
  }
  let lines: string[];
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    if (officeKindOf(bytes) !== "xlsx") {
      throw new PriceListRefusedError("That is not an Excel (.xlsx) file.");
    }
    let text: string;
    try {
      text = xlsxText(bytes);
    } catch (error) {
      throw new PriceListRefusedError(
        error instanceof UnreadableDocument
          ? `The workbook could not be read: ${error.message}.`
          : "The workbook could not be read.",
      );
    }
    // The first sheet only: a price list is one table.
    const first = text.split(/\n\n(?=Sheet ")/)[0] ?? "";
    lines = first.split("\n").slice(1);
  } else if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes)
      .replace(/^﻿/, "");
    lines = text.split(/\r?\n/);
  } else {
    throw new PriceListRefusedError("Upload a .csv or .xlsx file.");
  }
  const kept = lines
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.replace(/[,;\t\s"]/g, "") !== "")
    .map((line) => cutAtCodeUnits(line, MAX_LINE));
  const [header, ...rows] = kept;
  if (!header || rows.length === 0) {
    throw new PriceListRefusedError(
      "The file needs a header row and at least one product row.",
    );
  }
  if (rows.length > MAX_ROWS) {
    throw new PriceListRefusedError(`The list has more than ${MAX_ROWS} rows.`);
  }
  return { header, rows };
}

/** Lower case, no Greek accents, so «Ροζέ» finds «ροζε» and the other way round. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function matchingRows(rows: string[], query: string): string[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return rows.filter((row) => {
    const folded = fold(row);
    return words.every((word) => folded.includes(word));
  });
}

// ---- storage ---------------------------------------------------------------------------------

let database: Database | null = null;

/** Wired once at start (index.ts). */
export function usePriceListDatabase(value: Database | null): void {
  database = value;
}

async function load() {
  if (!database) return null;
  const [row] = await database
    .select()
    .from(priceList)
    .where(eq(priceList.id, LIST_ID));
  return row ?? null;
}

export async function priceListStatus(): Promise<PriceListView | null> {
  const row = await load();
  return row
    ? {
        fileName: row.fileName,
        uploadedAt: row.uploadedAt.toISOString(),
        rows: row.rows.length,
        header: row.header,
      }
    : null;
}

export async function savePriceList(input: {
  fileName: string;
  bytes: Uint8Array;
  by: string;
}): Promise<PriceListView> {
  if (!database) throw new PriceListRefusedError("No database.");
  const name = input.fileName.trim().slice(0, 200) || "price-list";
  const { header, rows } = priceRowsFrom(name, input.bytes);
  const values = {
    id: LIST_ID,
    fileName: name,
    header,
    rows,
    uploadedBy: input.by,
    uploadedAt: new Date(),
  };
  await database
    .insert(priceList)
    .values(values)
    .onConflictDoUpdate({ target: priceList.id, set: values });
  return (await priceListStatus()) as PriceListView;
}

export async function removePriceList(): Promise<void> {
  if (!database) return;
  await database.delete(priceList).where(eq(priceList.id, LIST_ID));
}

// ---- the tool --------------------------------------------------------------------------------

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "find_price",
    description:
      "Look a product up in the business's own price list and get its rows exactly as written there (code, name, size, price, VAT, whatever the list has). This is the only place a price may come from: never give a price from memory or guess one. If it says the prices are not loaded, tell the person that, and do not give any price.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words from the product's name or code, for example «Ασύρτικο 2023» or a product code.",
        },
      },
      required: ["query"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

function answer(text: string, isError = false): McpCallResult {
  const truncated = text.length > MAX_RESULT_CHARS;
  return {
    text: truncated ? cutAtCodeUnits(text, MAX_RESULT_CHARS) : text,
    isError,
    truncated,
  };
}

export async function callTool(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (toolName !== "find_price") {
    return answer(`There is no price-list tool called ${toolName}.`, true);
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 200) {
    return answer(
      "Say which product to look up, in up to 200 characters.",
      true,
    );
  }
  const row = await load();
  if (!row) return answer(NOT_LOADED);
  const found = matchingRows(row.rows, query);
  if (found.length === 0) {
    return answer(
      `No product in the price list (${row.fileName}) matches “${query}”. Do not give a price; try other words or the product code, or say it is not on the list.`,
    );
  }
  const shown = found.slice(0, MAX_MATCHES);
  return answer(
    [
      `From the price list ${row.fileName}, uploaded ${row.uploadedAt.toISOString().slice(0, 10)}. Give each price exactly as it is written in its row (14.90 stays 14.90: do not add a currency sign, change the decimal mark or round it). Say whether a price includes VAT only if the header or the row says so; if the list does not say, say that the list does not say.`,
      row.header,
      ...shown,
      ...(found.length > shown.length
        ? [
            `… and ${found.length - shown.length} more rows. Ask for more exact words to narrow it down.`,
          ]
        : []),
    ].join("\n"),
  );
}
