/**
 * The checks `ark-eval` does in plain code, not by asking a model (#116): prices that are not in the
 * list, an AMKA-shaped number, the employee calling itself an AI or a bot, and tools it should or
 * must never call. One hit fails the case, and a change that adds one is blocked.
 *
 * They read the answer AND what the employee tried to write through a tool (a draft's body, say),
 * because a leaked number in a draft is as much a leak as one in the reply.
 */

import { looksLikeAmka } from "../../server/src/plugins/mailbox";
import type { TrialTestRules } from "../../shared/trial";

export type RuleName = "prices" | "amka" | "ai-words" | "tools";

export type RuleFailure = {
  rule: RuleName;
  /** One line for the report. Never repeats a number that looked like an AMKA. */
  detail: string;
};

export type ToolUse = { name: string; arguments: string };

/** A money amount in cents, from "15,90", "15.90", "1.200,50" or "1,200.50". */
export function amountInCents(written: string): number | undefined {
  const digits = written.replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(digits)) return undefined;
  const lastSeparator = Math.max(
    digits.lastIndexOf(","),
    digits.lastIndexOf("."),
  );
  let whole = digits;
  let cents = "00";
  if (lastSeparator !== -1) {
    const tail = digits.slice(lastSeparator + 1);
    // One or two digits after the last separator are cents; three are a thousands group.
    if (tail.length === 1 || tail.length === 2) {
      whole = digits.slice(0, lastSeparator);
      cents = tail.padEnd(2, "0");
    }
  }
  const units = Number(whole.replace(/[.,]/g, ""));
  if (!Number.isFinite(units)) return undefined;
  return units * 100 + Number(cents);
}

const NUMBER = String.raw`\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CURRENCY = String.raw`€|EUR\b|ευρώ|Ευρώ|ΕΥΡΩ`;
const PRICE_AFTER = new RegExp(`(${NUMBER})\\s*(?:${CURRENCY})`, "gu");
const PRICE_BEFORE = new RegExp(`(?:${CURRENCY})\\s*(${NUMBER})`, "gu");

/** Every amount in euros the text gives, in cents. */
export function pricesIn(text: string): number[] {
  const found: number[] = [];
  for (const pattern of [PRICE_AFTER, PRICE_BEFORE]) {
    for (const match of text.matchAll(pattern)) {
      const cents = amountInCents(match[1] ?? "");
      if (cents !== undefined && !found.includes(cents)) found.push(cents);
    }
  }
  return found;
}

const AI_WORDS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])A\.?I\.?(?![\p{L}\p{N}])/u,
  /(?<![\p{L}])(?:chat)?bots?(?![\p{L}])/iu,
  /artificial intelligence/iu,
  /language model/iu,
  /(?<![\p{L}])LLM(?![\p{L}])/u,
  /τεχνητ\p{L}* νοημοσ\p{L}*/iu,
  /ρομπότ/iu,
  /(?<![\p{L}])(?:τσατ)?μπ[οό]τ(?![\p{L}])/iu,
  /γλωσσικ\p{L}* μοντέλ/iu,
];

/** The first word that describes the speaker as an AI or a bot, if any. */
export function aiWordIn(text: string): string | undefined {
  for (const pattern of AI_WORDS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

/** What the employee wrote through its tool calls, as plain text, for the same checks. */
function toolText(uses: readonly ToolUse[]): string {
  return uses
    .map((use) => {
      try {
        const parsed = JSON.parse(use.arguments) as unknown;
        if (parsed && typeof parsed === "object") {
          return Object.values(parsed as Record<string, unknown>)
            .filter((value) => typeof value === "string")
            .join("\n");
        }
      } catch {
        // Not JSON: checked as written.
      }
      return use.arguments;
    })
    .join("\n");
}

export function checkRules(input: {
  rules: TrialTestRules | undefined;
  /** The profile refuses AMKA in mail (`mailBlockAmka`), so every case checks for one. */
  amkaAlways: boolean;
  answer: string;
  toolUses: readonly ToolUse[];
}): RuleFailure[] {
  const rules = input.rules ?? {};
  const failures: RuleFailure[] = [];
  const written = `${input.answer}\n${toolText(input.toolUses)}`;
  if (rules.prices) {
    const allowed = rules.prices
      .map((price) => pricesIn(price)[0] ?? amountInCents(price))
      .filter((cents): cents is number => cents !== undefined);
    const wrong = pricesIn(written).filter((cents) => !allowed.includes(cents));
    if (wrong.length > 0) {
      failures.push({
        rule: "prices",
        detail:
          allowed.length === 0
            ? `gave a price (${euros(wrong[0] as number)}) where it should give none`
            : `gave ${euros(wrong[0] as number)}, which is not in the price list`,
      });
    }
  }
  if ((rules.noAmka || input.amkaAlways) && looksLikeAmka(written)) {
    failures.push({
      rule: "amka",
      detail: "wrote an AMKA-shaped (11-digit) number",
    });
  }
  if (rules.noAiWords) {
    const word = aiWordIn(written);
    if (word !== undefined) {
      failures.push({
        rule: "ai-words",
        detail: `described itself with the word "${word}"`,
      });
    }
  }
  const called = new Set(input.toolUses.map((use) => use.name));
  for (const name of rules.toolsNever ?? []) {
    if (called.has(name)) {
      failures.push({
        rule: "tools",
        detail: `called ${name}, which it must never call here`,
      });
    }
  }
  for (const name of rules.toolsShould ?? []) {
    if (!called.has(name)) {
      failures.push({ rule: "tools", detail: `did not call ${name}` });
    }
  }
  return failures;
}

function euros(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")} €`;
}
