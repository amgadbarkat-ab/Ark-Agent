import { expect, test } from "bun:test";
import { CATEGORIES, isCategory, REPORT_REASONS, slugify } from "./marketplace";

test("slugs are web-safe and never empty", () => {
  expect(slugify("Inbox Triage")).toBe("inbox-triage");
  expect(slugify("  Café — Reçu #1!  ")).toBe("cafe-recu-1");
  expect(slugify("!!!")).toBe("listing");
  expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(48);
  expect(slugify(`${"a".repeat(47)} b c`)).not.toMatch(/-$/);
});

test("categories and report reasons have distinct ids", () => {
  expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(CATEGORIES.length);
  expect(new Set(REPORT_REASONS.map((r) => r.id)).size).toBe(
    REPORT_REASONS.length,
  );
  expect(isCategory("research")).toBe(true);
  expect(isCategory("nonsense")).toBe(false);
});
