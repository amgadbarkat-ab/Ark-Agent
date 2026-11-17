/**
 * Competitor prices (#109, v0.1.44; Amgad 16 Nov), for every install.
 *
 * HOW IT RUNS. The watch list is the business data file named `price-watch` (one row per product:
 * name, own SKU, own price, and the addresses of its Skroutz and BestPrice comparison pages). On the
 * schedule the customer chose (a Routine, daily or hourly), the employee opens each page in its
 * browser like a person would, one page at a time, reads the shops and prices shown, and records
 * them here with `record_prices`. `price_report` then compares the latest with the shop's own price.
 * A price change is never made here: it goes through WooCommerce's `update_price`, held on an
 * approval card.
 *
 * WHAT IT DOES NOT DO. It does not fetch pages itself, run in parallel, hide that it is a browser,
 * or get past a CAPTCHA or a block. If a site shows one, the employee stops and says so (the tool
 * descriptions tell it to). Skroutz's terms forbid monitoring without its written permission; using
 * this on Skroutz without that is BlackArk's decision (Amgad, 16 Nov), noted on #109.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { businessFiles, priceObservations } from "../db/schema";
import { answer } from "./business-http";
import type { McpCallResult, McpTool } from "./mcp";

export const WATCH_FILE = "price-watch";
const MAX_OBSERVATIONS = 40;

let database: Database | null = null;

/** Wired once at start (index.ts). */
export function usePriceWatchDatabase(value: Database | null): void {
  database = value;
}

/** "14,90 €", "€ 1.234,50", "14.90" → cents; null when it is not a price. */
export function priceCents(text: string): number | null {
  const cleaned = text.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);
  let whole = cleaned;
  let fraction = "";
  if (decimalAt >= 0 && cleaned.length - decimalAt - 1 <= 2) {
    whole = cleaned.slice(0, decimalAt);
    fraction = cleaned.slice(decimalAt + 1);
  }
  const units = Number(whole.replace(/[.,]/g, "") || "0");
  const cents = Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isFinite(units) || !Number.isFinite(cents)) return null;
  return units * 100 + cents;
}

function euros(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

const PACE =
  "Open one page at a time, as a person would, and wait for each to load before the next; never open pages in parallel. If a site shows a CAPTCHA, a robot check or a block, stop, record nothing for it, and tell the person: do not try to get past it.";

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "watch_list",
    description: `The products whose competitor prices the business watches, from its data file "${WATCH_FILE}": each product's name, own SKU, own price, and the comparison pages (Skroutz, BestPrice) to read. ${PACE}`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "record_prices",
    description: `Record the shops and prices you just read on one product's comparison page, exactly as the page showed them (for example "14,90 €"). One call per page. ${PACE}`,
    inputSchema: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description: "The product's name as in the watch list.",
        },
        url: { type: "string", description: "The page you read." },
        offers: {
          type: "array",
          maxItems: MAX_OBSERVATIONS,
          items: {
            type: "object",
            properties: {
              shop: { type: "string" },
              price: { type: "string" },
            },
            required: ["shop", "price"],
          },
        },
      },
      required: ["product", "url", "offers"],
    },
  },
  {
    name: "price_report",
    description:
      "The latest competitor prices recorded, per product: the cheapest offers, when they were read, and how they compare with the business's own price from the watch list. Any price change is proposed through the shop's own price tool, which waits for approval.",
    inputSchema: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description: "One product, or leave empty for all.",
        },
      },
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type WatchItem = { line: string; name: string; ownCents: number | null };

/** The watch list's rows: the first column is the product's name; an "own price" column is found by its header. */
async function watchList(): Promise<{
  header: string;
  items: WatchItem[];
} | null> {
  if (!database) return null;
  const [row] = await database
    .select()
    .from(businessFiles)
    .where(eq(businessFiles.name, WATCH_FILE));
  if (!row) return null;
  const separator = row.header.includes(";")
    ? ";"
    : row.header.includes("\t")
      ? "\t"
      : ",";
  const columns = row.header
    .split(separator)
    .map((cell) => cell.trim().toLowerCase());
  const ownAt = columns.findIndex((cell) =>
    /own|δική|τιμή μας|our price|price/.test(cell),
  );
  return {
    header: row.header,
    items: row.rows.map((line) => {
      const cells = line.split(separator).map((cell) => cell.trim());
      const own = ownAt >= 0 ? (cells[ownAt] ?? "") : "";
      return {
        line,
        name: cells[0] ?? line,
        ownCents: own ? priceCents(own) : null,
      };
    }),
  };
}

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export async function callTool(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!database)
    return answer("Competitor prices are not available here.", true);
  const list = await watchList();
  if (toolName === "watch_list") {
    if (!list || list.items.length === 0) {
      return answer(
        `There is no watch list yet. An administrator uploads it in Settings, then Connect your Data, then Business data files, under the name "${WATCH_FILE}": one row per product with its name, own price and comparison page addresses.`,
      );
    }
    return answer(
      [
        `Watch list (${list.items.length} products). ${PACE}`,
        list.header,
        ...list.items.map((item) => item.line),
      ].join("\n"),
    );
  }
  if (toolName === "record_prices") {
    const product = typeof args.product === "string" ? args.product.trim() : "";
    const url = typeof args.url === "string" ? args.url.trim() : "";
    const offers = Array.isArray(args.offers) ? args.offers : [];
    if (!product || product.length > 200) {
      return answer("Say which product, as in the watch list.", true);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return answer("Give the address of the page you read.", true);
    }
    if (parsed.protocol !== "https:") {
      return answer("The page address must start with https://.", true);
    }
    const rows = offers
      .slice(0, MAX_OBSERVATIONS)
      .map((raw) => raw as Record<string, unknown>)
      .map((offer) => ({
        shop:
          typeof offer.shop === "string" ? offer.shop.trim().slice(0, 120) : "",
        price:
          typeof offer.price === "string"
            ? offer.price.trim().slice(0, 40)
            : "",
      }))
      .filter((offer) => offer.shop && offer.price);
    if (rows.length === 0) {
      return answer("Record at least one shop with its price.", true);
    }
    const now = new Date();
    await database.insert(priceObservations).values(
      rows.map((offer) => ({
        id: randomUUID(),
        item: product,
        shop: offer.shop,
        price: offer.price,
        priceCents: priceCents(offer.price),
        url: parsed.toString(),
        seenAt: now,
      })),
    );
    return answer(
      `Recorded ${rows.length} prices for ${product} from ${parsed.host}.`,
    );
  }
  if (toolName !== "price_report") {
    return answer(
      `There is no competitor-price tool called ${toolName}.`,
      true,
    );
  }
  const wanted = typeof args.product === "string" ? fold(args.product) : "";
  const recent = await database
    .select()
    .from(priceObservations)
    .orderBy(desc(priceObservations.seenAt))
    .limit(2000);
  const byItem = new Map<string, typeof recent>();
  for (const row of recent) {
    if (wanted && !fold(row.item).includes(wanted)) continue;
    const latest = byItem.get(row.item);
    if (!latest) byItem.set(row.item, [row]);
    else if (latest[0]?.seenAt.getTime() === row.seenAt.getTime())
      latest.push(row);
  }
  if (byItem.size === 0) {
    return answer(
      wanted
        ? "No competitor prices are recorded for that product yet."
        : "No competitor prices are recorded yet.",
    );
  }
  const lines: string[] = [];
  for (const [item, rows] of byItem) {
    const sorted = [...rows].sort(
      (a, b) =>
        (a.priceCents ?? Number.MAX_SAFE_INTEGER) -
        (b.priceCents ?? Number.MAX_SAFE_INTEGER),
    );
    const own = list?.items.find(
      (entry) => fold(entry.name) === fold(item),
    )?.ownCents;
    const cheapest = sorted[0]?.priceCents;
    lines.push(
      `${item}: read ${rows[0]?.seenAt.toISOString().slice(0, 16).replace("T", " ")} UTC from ${new URL(rows[0]?.url ?? "https://x").host}.`,
    );
    for (const row of sorted.slice(0, 5)) {
      lines.push(`  ${row.shop}: ${row.price}`);
    }
    if (own != null && cheapest != null) {
      lines.push(
        own <= cheapest
          ? `  Our price ${euros(own)} is the lowest or equal.`
          : `  Our price ${euros(own)} is ${euros(own - cheapest)} above the cheapest.`,
      );
    }
  }
  return answer(lines.join("\n"));
}
