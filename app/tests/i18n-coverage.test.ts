import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EL } from "../../shared/i18n/el";
import {
  missingGreek,
  translateSentence,
  translateText,
} from "../../shared/i18n/translate";
import { scan } from "./support/english-scan";

/**
 * The whole app in Greek when Greek is chosen (MD order, #108). These hold it there: a screen that
 * writes English straight into the page, or a text given to `t()` with no Greek, fails the build.
 */
// Every file, the shared primitives in components/ui included: their labels ("Close", "Toggle
// Sidebar") are read on every screen.
const { raw, translated } = scan(join(import.meta.dir, "../src"));

/** The first keys (`sidebar.search` and the like), translated by their own table in lib/i18n.ts. */
const KEYED = /^[a-z]+(\.[a-zA-Z]+)+$/;

describe("the app in Greek", () => {
  test("no screen writes English straight into the page", () => {
    expect(raw.map((f) => `${f.file}:${f.line}  ${f.text}`)).toEqual([]);
  });

  test("every text given to t() has its Greek", () => {
    const texts = translated.map((f) => f.text).filter((t) => !KEYED.test(t));
    expect(missingGreek(texts)).toEqual([]);
  });

  test("every Greek text keeps the placeholders of its English", () => {
    const broken = Object.entries(EL).filter(([english, greek]) => {
      const names = (text: string) =>
        [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      return names(english).join() !== names(greek).join();
    });
    expect(broken).toEqual([]);
  });
});

describe("translating", () => {
  test("a text with values fills them in, in either language", () => {
    expect(
      translateText("en", "{done} of {total}", { done: 2, total: 5 }),
    ).toBe("2 of 5");
    expect(
      translateText("el", "{done} of {total}", { done: 2, total: 5 }),
    ).toBe("2 από 5");
  });

  test("a sentence from the server is matched whole, or by its pattern", () => {
    expect(translateSentence("el", "That request failed.")).toBe(
      "Το αίτημα απέτυχε.",
    );
    expect(translateSentence("el", "Next tomorrow")).toBe("Επόμενη tomorrow");
    expect(translateSentence("en", "That request failed.")).toBe(
      "That request failed.",
    );
  });

  test("an unknown sentence stays as it came", () => {
    expect(translateSentence("el", "Something nobody wrote down.")).toBe(
      "Something nobody wrote down.",
    );
  });
});
