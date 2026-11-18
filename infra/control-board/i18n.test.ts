import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { EL, money, t, when } from "./i18n";

/** Every English phrase the pages pass to t(…), read from the source. */
function phrasesUsed(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(import.meta.dir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  )) {
    const text = readFileSync(`${import.meta.dir}/${file}`, "utf8");
    for (const match of text.matchAll(
      /\bt\(\s*(?:l|lang|frame\.lang|context\.lang),\s*"((?:[^"\\]|\\.)*)"/g,
    )) {
      found.add(JSON.parse(`"${match[1]}"`));
    }
    if (file !== "pages.ts" && file !== "board.ts" && file !== "cases.ts")
      continue;
    // Words handed to t() through a table: ["/customers", "Customers", …], { key: "Text" }, and the
    // lower-case words in the pages' maps ({ incoming: "incoming" }).
    const tables = [
      /\[\s*(?:"[^"]*"|null),\s*"([A-Z][a-z][^"]*)"/g,
      /^\s+(?:[\w]+|"[\w-]+"): "([A-Z][a-z][^"]*)",?$/gm,
      /^\s+(?:[\w]+|"[\w-]+"): "([a-z][a-z ]+)",?$/gm,
      /name: "([A-Z][^"]*)"/g,
    ];
    for (const pattern of tables) {
      for (const match of text.matchAll(pattern)) found.add(match[1] as string);
    }
  }
  return [...found];
}

test("every phrase the board shows has Greek", () => {
  // Header values and other words that are never shown.
  const notShown = new Set(["nosniff", "same-origin", "case"]);
  const missing = phrasesUsed().filter(
    (phrase) => !(phrase in EL) && !notShown.has(phrase),
  );
  expect(missing).toEqual([]);
});

test("placeholders are filled in both languages", () => {
  expect(t("en", "{n} days left", { n: 5 })).toBe("5 days left");
  expect(t("el", "{n} days left", { n: 5 })).toBe("απομένουν 5 ημέρες");
});

test("times are Athens time, money in euros the Greek way in Greek", () => {
  expect(when("en", "2026-11-18T10:00:00Z")).toBe("18/11/2026 12:00");
  expect(when("el", "2026-07-01T10:00:00Z")).toBe("01/07/2026 13:00");
  expect(money("en", 23400)).toBe("EUR 23.40");
  expect(money("el", 8340)).toBe("8,34 €");
});
