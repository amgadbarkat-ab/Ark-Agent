/**
 * Competitor prices (#109, v0.1.44): the watch list is the "price-watch" data file; the employee
 * records what a comparison page showed; the report compares the latest with the shop's own price.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { businessFiles, priceObservations } from "../src/db/schema";
import {
  saveBusinessFile,
  useBusinessFilesDatabase,
} from "../src/plugins/business-files";
import { catalogueEntry } from "../src/plugins/catalogue";
import {
  callTool,
  priceCents,
  usePriceWatchDatabase,
} from "../src/plugins/price-watch";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool({ url: "builtin://price-watch" }, name, args);

beforeAll(async () => {
  useBusinessFilesDatabase(database);
  usePriceWatchDatabase(database);
  await database.delete(priceObservations);
  await database.delete(businessFiles);
});
afterAll(async () => {
  await database.delete(priceObservations);
  await database.delete(businessFiles);
  useBusinessFilesDatabase(null);
  usePriceWatchDatabase(null);
  await database.$client.close();
});

test("prices are read as written, Greek or English", () => {
  expect(priceCents("14,90 €")).toBe(1490);
  expect(priceCents("€ 1.234,50")).toBe(123450);
  expect(priceCents("14.90")).toBe(1490);
  expect(priceCents("12 €")).toBe(1200);
  expect(priceCents("χωρίς τιμή")).toBeNull();
});

test("without a watch list it says how to add one; with one, it lists it and tells the pace", async () => {
  expect((await tool("watch_list")).text).toContain(
    'under the name "price-watch"',
  );
  await saveBusinessFile({
    name: "price-watch",
    fileName: "watch.csv",
    bytes: new TextEncoder().encode(
      "Προϊόν;SKU;Our price;Skroutz;BestPrice\nΛευκό κρασί 750ml;W-101;15,90 €;https://www.skroutz.gr/s/1/x.html;https://www.bestprice.gr/item/1/x.html\n",
    ),
    by: null,
  });
  const listed = (await tool("watch_list")).text;
  expect(listed).toContain("W-101");
  expect(listed).toContain("one page at a time");
  expect(listed).toContain("CAPTCHA");
});

test("recorded prices are reported cheapest first, against our own price", async () => {
  const recorded = await tool("record_prices", {
    product: "Λευκό κρασί 750ml",
    url: "https://www.skroutz.gr/s/1/x.html",
    offers: [
      { shop: "Κάβα Α", price: "14,90 €" },
      { shop: "Κάβα Β", price: "16,20 €" },
    ],
  });
  expect(recorded.text).toBe(
    "Recorded 2 prices for Λευκό κρασί 750ml from www.skroutz.gr.",
  );
  const report = (await tool("price_report", { product: "λευκο" })).text;
  expect(report.indexOf("Κάβα Α")).toBeLessThan(report.indexOf("Κάβα Β"));
  expect(report).toContain("Our price 15,90 € is 1,00 € above the cheapest.");
});

test("a page that is not https, or no offers, is refused; nothing here changes a price", async () => {
  expect(
    (
      await tool("record_prices", {
        product: "x",
        url: "http://a.gr",
        offers: [{ shop: "a", price: "1" }],
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await tool("record_prices", {
        product: "x",
        url: "https://a.gr",
        offers: [],
      })
    ).isError,
  ).toBe(true);
  expect(catalogueEntry("price-watch")?.writeTools).toEqual([]);
});
