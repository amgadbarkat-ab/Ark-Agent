/**
 * The whole app in English or Greek (MD order, 13 Nov 2026, #108: "if the user chose GR the full
 * app, in all parts, pages and messages, must show in GR").
 *
 * KEYED ON THE ENGLISH ITSELF. A screen writes `t("Save changes")`, and the Greek table maps that
 * sentence to its Greek. Two thousand texts converted one by one is only workable when a text needs
 * no invented name, and the English stays readable where it is used. Nothing is lost when a Greek
 * entry is missing: the English is shown, and `missingGreek` (and the CI test over it) says which.
 *
 * Placeholders are written `{name}` in both languages and filled in from `values`.
 *
 * ONE TABLE FOR EVERY SURFACE. The browser app, the desktop setup window, and the sentences the
 * server and the desktop engine send back all read it, so a sentence translated once is Greek
 * wherever it appears. Sentences that arrive whole (an error from the server, a step from the
 * desktop engine) are matched by `translateSentence`, which also understands entries with
 * placeholders, so "Your Gmail sign-in has expired" matches "Your {title} sign-in has expired".
 */
import { EL } from "./el";

export type Language = "en" | "el";

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** The text in `language`, with `{name}` filled in. English when there is no Greek for it. */
export function translateText(
  language: Language,
  english: string,
  values: Record<string, string | number> = {},
): string {
  const text = language === "el" ? (EL[english] ?? english) : english;
  return fill(text, values);
}

type Pattern = { match: RegExp; names: string[]; greek: string };

let patterns: Pattern[] | null = null;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Entries with placeholders, longest first so the most specific one wins. */
function compiled(): Pattern[] {
  if (patterns) return patterns;
  patterns = Object.entries(EL)
    .filter(([english]) => /\{\w+\}/.test(english))
    .sort(([a], [b]) => b.length - a.length)
    .map(([english, greek]) => {
      const names: string[] = [];
      const source = english
        .split(PLACEHOLDER)
        .map((part, index) => {
          if (index % 2 === 1) {
            names.push(part);
            return "([\\s\\S]+?)";
          }
          return escape(part);
        })
        .join("");
      return { match: new RegExp(`^${source}$`), names, greek };
    });
  return patterns;
}

/**
 * A whole sentence that arrived from elsewhere (the server, the desktop engine), in `language`.
 *
 * Exact first, then the entries with placeholders. A sentence of several known sentences in a row
 * ("That failed. Try again.") is translated sentence by sentence, so a reason and a next step
 * written as two entries still read as one Greek message. Anything unknown stays as it came.
 */
export function translateSentence(
  language: Language,
  sentence: string,
): string {
  if (language !== "el" || !sentence) return sentence;
  const whole = whole1(sentence);
  if (whole !== null) return whole;
  // Sentence by sentence, keeping what could not be matched as it was.
  const parts = sentence.match(/[^.!?…]+[.!?…]+["»)]?\s*|[^.!?…]+$/g);
  if (!parts || parts.length < 2) return sentence;
  let changed = false;
  const out = parts.map((part) => {
    const trimmed = part.trim();
    const greek = whole1(trimmed);
    if (greek === null) return part;
    changed = true;
    return part.replace(trimmed, greek);
  });
  return changed ? out.join("") : sentence;
}

function whole1(sentence: string): string | null {
  const exact = EL[sentence];
  if (exact !== undefined) return exact;
  for (const pattern of compiled()) {
    const found = pattern.match.exec(sentence);
    if (!found) continue;
    const values: Record<string, string> = {};
    pattern.names.forEach((name, index) => {
      const value = found[index + 1] ?? "";
      // A value that is itself a known phrase (a status, a step) is translated too.
      values[name] = EL[value] ?? value;
    });
    return fill(pattern.greek, values);
  }
  return null;
}

/** The English texts given that have no Greek yet. For the CI test and the review sheet. */
export function missingGreek(englishTexts: Iterable<string>): string[] {
  const missing = new Set<string>();
  for (const text of englishTexts) {
    if (!(text in EL)) missing.add(text);
  }
  return [...missing].sort();
}
