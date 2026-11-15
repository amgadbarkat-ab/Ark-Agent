/**
 * The business's price list (#109, MD 15 Nov): uploaded as CSV or XLSX, searched by `find_price`,
 * and "not loaded" until there is one, so an employee says so rather than guesses.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { priceList, users } from "../src/db/schema";
import { catalogueEntry } from "../src/plugins/catalogue";
import {
  callTool,
  fold,
  listTools,
  NOT_LOADED,
  PriceListRefusedError,
  priceListStatus,
  priceRowsFrom,
  removePriceList,
  savePriceList,
  usePriceListDatabase,
} from "../src/plugins/price-list";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const userId = `price-list-${randomUUID()}`;
usePriceListDatabase(database);

afterAll(async () => {
  await database.delete(priceList);
  await database.delete(users).where(eq(users.id, userId));
  usePriceListDatabase(null);
  await database.$client.close();
});

const find = (query: string) =>
  callTool({ url: "builtin://price-list" }, "find_price", { query });

const csv = [
  "﻿Κωδικός;Προϊόν;Μέγεθος;Τιμή;ΦΠΑ",
  "A23;Ασύρτικο Σαντορίνης 2023;750ml;18,50;24%",
  "R22;Ροζέ Ξινόμαυρο 2022;750ml;12,90;24%",
  "",
  "M21;Μαλαγουζιά 2021;1500ml;29,00;24%",
].join("\r\n");

/** The smallest workbook the reader accepts: one sheet, inline strings. */
function xlsx(rows: string[][]): Uint8Array {
  const files: Record<string, string> = {
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="Τιμές" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((cell) => `<c t="inlineStr"><is><t>${cell}</t></is></c>`)
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`,
  };
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

describe("the price list (#109)", () => {
  test("one read-only tool, nothing to approve", async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual([
      "find_price",
    ]);
    expect(catalogueEntry("price-list")?.writeTools).toEqual([]);
  });

  test("before any upload, the answer is that prices are not loaded", async () => {
    await removePriceList();
    const result = await find("Ασύρτικο");
    expect(result.isError).toBe(false);
    expect(result.text).toBe(NOT_LOADED);
    expect(result.text).toContain("Οι τιμές δεν έχουν φορτωθεί ακόμη");
  });

  test("a CSV is kept row by row; a search finds rows as written, with or without Greek accents", async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: "Admin" });
    const saved = await savePriceList({
      fileName: "timokatalogos.csv",
      bytes: new TextEncoder().encode(csv),
      by: userId,
    });
    expect(saved).toMatchObject({
      fileName: "timokatalogos.csv",
      rows: 3,
      header: "Κωδικός;Προϊόν;Μέγεθος;Τιμή;ΦΠΑ",
    });
    const found = await find("ασυρτικο");
    expect(found.text).toContain(
      "A23;Ασύρτικο Σαντορίνης 2023;750ml;18,50;24%",
    );
    expect(found.text).toContain("Κωδικός;Προϊόν");
    expect(found.text).not.toContain("Ροζέ");
    expect((await find("ΡΟΖΕ 2022")).text).toContain("12,90");
    expect((await find("M21")).text).toContain("29,00");
    const none = await find("Σαμπάνια");
    expect(none.text).toContain("No product in the price list");
    expect(none.text).toContain("Do not give a price");
    expect(fold("Ροζέ")).toBe("ροζε");
  });

  test("an XLSX is read from its first sheet, and replaces the list", async () => {
    const saved = await savePriceList({
      fileName: "prices.xlsx",
      bytes: xlsx([
        ["SKU", "Product", "Price"],
        ["V1", "Βινσάντο 2015", "34.00"],
      ]),
      by: userId,
    });
    expect(saved.rows).toBe(1);
    expect((await find("βινσαντο")).text).toContain("V1");
    expect((await find("Ασύρτικο")).text).toContain("No product");
    expect((await priceListStatus())?.fileName).toBe("prices.xlsx");
  });

  test("refuses other file types, an empty file and a list with no rows", () => {
    const bytes = new TextEncoder().encode("only a header");
    expect(() => priceRowsFrom("list.pdf", bytes)).toThrow(
      PriceListRefusedError,
    );
    expect(() => priceRowsFrom("list.csv", new Uint8Array())).toThrow(
      PriceListRefusedError,
    );
    expect(() => priceRowsFrom("list.csv", bytes)).toThrow(
      PriceListRefusedError,
    );
    expect(() => priceRowsFrom("list.xlsx", bytes)).toThrow(
      PriceListRefusedError,
    );
  });
});
