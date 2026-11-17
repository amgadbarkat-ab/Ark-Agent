/**
 * The business's data files (#109, v0.1.43): Pylon's exports or any other table, uploaded under a
 * short name and searched by `find_rows`, exactly as written.
 */
import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { businessFiles } from "../src/db/schema";
import {
  BusinessFileRefusedError,
  callTool,
  listBusinessFiles,
  saveBusinessFile,
  useBusinessFilesDatabase,
} from "../src/plugins/business-files";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
useBusinessFilesDatabase(database);

afterAll(async () => {
  await database.delete(businessFiles);
  useBusinessFilesDatabase(null);
  await database.$client.close();
});

const bytes = (text: string) => new TextEncoder().encode(text);

test("an export is stored under its name and its rows are found as written", async () => {
  await database.delete(businessFiles);
  const empty = await callTool(
    { url: "builtin://business-files" },
    "list_data_files",
    {},
  );
  expect(empty.text).toContain("No data files are uploaded yet");

  await saveBusinessFile({
    name: "Stock",
    fileName: "pylon-stock.csv",
    bytes: bytes(
      "Κωδικός;Περιγραφή;Απόθεμα\nW-101;Λευκό κρασί 750ml;12\nW-102;Ροζέ 750ml;0\n",
    ),
    by: null,
  });
  const listed = await callTool(
    { url: "builtin://business-files" },
    "list_data_files",
    {},
  );
  expect(listed.text).toContain("stock: pylon-stock.csv, 2 rows");

  const found = await callTool(
    { url: "builtin://business-files" },
    "find_rows",
    {
      file: "stock",
      query: "ροζε",
    },
  );
  expect(found.text).toContain("W-102;Ροζέ 750ml;0");
  expect(found.text).not.toContain("W-101");

  const missing = await callTool(
    { url: "builtin://business-files" },
    "find_rows",
    {
      file: "sales",
      query: "x",
    },
  );
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("The files are: stock");
});

test("a bad name or an empty file is refused, and a new upload replaces the old", async () => {
  await expect(
    saveBusinessFile({
      name: "my file!",
      fileName: "a.csv",
      bytes: bytes("a\n1\n"),
      by: null,
    }),
  ).rejects.toThrow(BusinessFileRefusedError);
  await expect(
    saveBusinessFile({
      name: "items",
      fileName: "a.csv",
      bytes: bytes(""),
      by: null,
    }),
  ).rejects.toThrow("empty");
  await saveBusinessFile({
    name: "stock",
    fileName: "new.csv",
    bytes: bytes("a\n1\n2\n3\n"),
    by: null,
  });
  const stock = (await listBusinessFiles()).find(
    (file) => file.name === "stock",
  );
  expect(stock).toMatchObject({ fileName: "new.csv", rows: 3 });
});

test("the watched folder loads each export by its file name, and again only when it changes (v0.1.45)", async () => {
  const { mkdtemp, writeFile, utimes, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { importBusinessFolder, nameFromFile } = await import(
    "../src/plugins/business-files"
  );
  expect(nameFromFile("Stock Export.xlsx")).toBe("stock-export");
  expect(nameFromFile("ΑΠΟΘΕΜΑ.csv")).toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "ark-data-in-"));
  try {
    await writeFile(join(dir, "Pylon Items.csv"), "Κωδικός;Είδος\nA1;Κρασί\n");
    await writeFile(join(dir, "notes.docx"), "not a table");
    expect(await importBusinessFolder(dir)).toEqual(["pylon-items"]);
    // Unchanged: nothing to do.
    expect(await importBusinessFolder(dir)).toEqual([]);
    // A newer export replaces it.
    await writeFile(
      join(dir, "Pylon Items.csv"),
      "Κωδικός;Είδος\nA1;Κρασί\nA2;Ροζέ\n",
    );
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, "Pylon Items.csv"), later, later);
    expect(await importBusinessFolder(dir)).toEqual(["pylon-items"]);
    const items = (await listBusinessFiles()).find(
      (file) => file.name === "pylon-items",
    );
    expect(items?.rows).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
