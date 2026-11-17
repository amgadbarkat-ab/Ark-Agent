/** The test-case format in the trial profile, and the proposed-change file (#116). */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readProfile, TrialFormatError } from "./trial";
import { readProposedChange } from "./trial-change";

const oneCase = (id: string) => ({
  id,
  ask: "Πού είναι η παραγγελία μου;",
  must: ["asks for the order number"],
  mustNot: ["invents a delivery date"],
});
const fiveCases = ["a", "b", "c", "d", "e"].map(oneCase);

const draft = (tests: unknown, extra: Record<string, unknown> = {}) => ({
  v: 1,
  customer: { id: "demo-shop", name: "Demo Shop" },
  issuedAt: "2026-11-15T10:00:00Z",
  startsAt: "2026-11-16T00:00:00+02:00",
  endsAt: "2026-12-16T00:00:00+02:00",
  plan: "team",
  createBlocked: true,
  roster: [
    {
      key: "orders",
      name: "Orders",
      title: "Orders",
      roleDescription: "Answers order questions.",
      instructions: "Ask for the order number.",
      ...(tests === undefined ? {} : { tests }),
    },
  ],
  ...extra,
});

function refusal(tests: unknown): string {
  try {
    readProfile(draft(tests));
  } catch (error) {
    expect(error).toBeInstanceOf(TrialFormatError);
    return (error as Error).message;
  }
  throw new Error("the profile was accepted");
}

describe("test cases in the trial profile", () => {
  test("are kept as written, with their rules and tool answers", () => {
    const tests = [
      {
        ...oneCase("price"),
        rules: {
          prices: ["6,40 €"],
          noAmka: true,
          noAiWords: true,
          toolsShould: ["find_price", "find_price"],
          toolsNever: ["send_message"],
        },
        toolAnswers: { find_price: "Λευκό 750ml | 6,40 €" },
      },
      ...fiveCases.slice(1),
    ];
    const [entry] = readProfile(draft(tests)).roster;
    expect(entry?.tests).toHaveLength(5);
    expect(entry?.tests?.[0]).toEqual({
      id: "price",
      ask: "Πού είναι η παραγγελία μου;",
      must: ["asks for the order number"],
      mustNot: ["invents a delivery date"],
      rules: {
        prices: ["6,40 €"],
        noAmka: true,
        noAiWords: true,
        toolsShould: ["find_price"],
        toolsNever: ["send_message"],
      },
      toolAnswers: { find_price: "Λευκό 750ml | 6,40 €" },
    });
  });

  test("an employee without cases is fine", () => {
    expect(readProfile(draft(undefined)).roster[0]?.tests).toBeUndefined();
  });

  test("malformed cases are refused with one clear sentence", () => {
    expect(refusal(fiveCases.slice(0, 4))).toBe(
      'The test cases for "orders" must be a list of 5 to 8 cases.',
    );
    expect(refusal([...fiveCases, ...["f", "g", "h", "i"].map(oneCase)])).toBe(
      'The test cases for "orders" must be a list of 5 to 8 cases.',
    );
    expect(refusal([...fiveCases.slice(0, 4), oneCase("a")])).toBe(
      'Test case 5 for "orders" needs an id of lower-case letters, numbers and hyphens, used once.',
    );
    expect(
      refusal([...fiveCases.slice(0, 4), { ...oneCase("e"), ask: " " }]),
    ).toBe('Test case "e" for "orders" has no question (ask).');
    expect(
      refusal([...fiveCases.slice(0, 4), { ...oneCase("e"), must: [] }]),
    ).toBe('Test case "e" for "orders"\'s "must" list needs 1 to 10 entries.');
    expect(
      refusal([
        ...fiveCases.slice(0, 4),
        { ...oneCase("e"), rules: { price: [] } },
      ]),
    ).toBe(
      'Test case "e" for "orders" has a rule called "price". Known: prices, noAmka, noAiWords, toolsShould, toolsNever.',
    );
    expect(
      refusal([
        ...fiveCases.slice(0, 4),
        {
          ...oneCase("e"),
          rules: {
            toolsShould: ["send_message"],
            toolsNever: ["send_message"],
          },
        },
      ]),
    ).toBe(
      'Test case "e" for "orders" says the tool send_message both should and must never be called.',
    );
    expect(
      refusal([
        ...fiveCases.slice(0, 4),
        { ...oneCase("e"), rules: { noAmka: "yes" } },
      ]),
    ).toBe('Test case "e" for "orders"\'s rule noAmka must be true or false.');
    expect(refusal("five cases")).toBe(
      'The test cases for "orders" must be a list of 5 to 8 cases.',
    );
  });

  test("the profile's notes are kept, and refused when not text", () => {
    expect(
      readProfile(draft(undefined, { notes: ["Signed for DT."] })).notes,
    ).toEqual(["Signed for DT."]);
    expect(() => readProfile(draft(undefined, { notes: "one note" }))).toThrow(
      TrialFormatError,
    );
  });

  test("the example cases in docs are a valid profile, 5 to 8 cases per employee", () => {
    const raw = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../docs/trials/eval-cases-example.json"),
        "utf8",
      ),
    );
    const profile = readProfile({ ...raw, issuedAt: "2026-11-20T09:00:00Z" });
    expect(profile.roster.map((entry) => entry.key)).toEqual([
      "front-desk",
      "results-admin",
      "b2b-orders",
    ]);
    for (const entry of profile.roster) {
      expect(entry.tests?.length).toBeGreaterThanOrEqual(5);
      expect(entry.tests?.length).toBeLessThanOrEqual(8);
    }
    const change = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../docs/trials/eval-change-example.json"),
        "utf8",
      ),
    );
    expect(readProposedChange(change, profile).employee).toBe("b2b-orders");
  });
});

describe("a proposed change", () => {
  const profile = readProfile(draft(fiveCases));
  const change = {
    format: "arkchange/1" as const,
    customer: "demo-shop",
    employee: "orders",
    instructions: "Ask for the order number and the business name.",
  };

  test("is read for its customer and employee", () => {
    expect(readProposedChange({ ...change, source: "tune" }, profile)).toEqual({
      ...change,
      source: "tune",
    });
  });

  test("for another customer, an unknown employee or the same text, is refused", () => {
    expect(() =>
      readProposedChange({ ...change, customer: "other-shop" }, profile),
    ).toThrow('This change is for the customer "other-shop", not "demo-shop".');
    expect(() =>
      readProposedChange({ ...change, employee: "nobody" }, profile),
    ).toThrow(
      'This change is for the employee "nobody", who is not in the profile.',
    );
    expect(() =>
      readProposedChange(
        { ...change, instructions: "Ask for the order number." },
        profile,
      ),
    ).toThrow("the same as the current one");
    expect(() =>
      readProposedChange({ ...change, format: "x" }, profile),
    ).toThrow("This is not a proposed change");
  });
});
