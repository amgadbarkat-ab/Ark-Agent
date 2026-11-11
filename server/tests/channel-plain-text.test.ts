import { expect, test } from "bun:test";
import { withoutMarkdown } from "../src/channels/text";

/** Desk #83 (d): a conversation was listed as "- **test-note.txt**: …" until it was named. */

test.each([
  [
    "- **test-note.txt**: a short note about wines",
    "test-note.txt: a short note about wines",
  ],
  ["## Τι λείπει", "Τι λείπει"],
  ["1. First, check the *order*", "First, check the order"],
  ["> quoted `code` and ~~gone~~", "quoted code and gone"],
  [
    "See [the price list](https://x.example/p) ![chart](c.png)",
    "See the price list chart",
  ],
  ["* [x] done item", "done item"],
  ["__Παραγγελία__ για _σήμερα_", "Παραγγελία για σήμερα"],
])("%s", (input, expected) => {
  expect(withoutMarkdown(input)).toBe(expected);
});

test("an asterisk or underscore inside a word is not emphasis, and no word is lost", () => {
  expect(withoutMarkdown("snake_case_name and 2*3*4 and a * b")).toBe(
    "snake_case_name and 2*3*4 and a * b",
  );
  expect(withoutMarkdown("Plain title, nothing to do")).toBe(
    "Plain title, nothing to do",
  );
});
