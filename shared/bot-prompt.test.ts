import { describe, expect, test } from "bun:test";
import {
  COMPUTER_GUIDANCE,
  IDENTITY_GUIDANCE,
  SELF_DESCRIPTION_GUIDANCE,
} from "./bot-prompt";

describe("COMPUTER_GUIDANCE", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(COMPUTER_GUIDANCE).toContain("\n\n");
    expect(COMPUTER_GUIDANCE).not.toContain("  ");
  });

  test("keeps each paragraph as one unbroken line of prose", () => {
    for (const paragraph of COMPUTER_GUIDANCE.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("still contains the full instruction text, unchanged in wording", () => {
    expect(COMPUTER_GUIDANCE).toContain(
      "You have your own computer: a real web browser the person can watch you use, and a workspace of files.",
    );
    expect(COMPUTER_GUIDANCE).toContain(
      "Say what you found or did in plain language, briefly.",
    );
  });
});

describe("IDENTITY_GUIDANCE (DT Lab, #109, 19 Nov: a Legal Helper named its model's maker as its employer)", () => {
  test("every employee is told it, inside the self-description every prompt already carries", () => {
    expect(SELF_DESCRIPTION_GUIDANCE).toContain(IDENTITY_GUIDANCE);
  });

  test("with no company named, it is the business's Ark Team from BlackArk, and no model maker is named", () => {
    expect(IDENTITY_GUIDANCE).toContain(
      "If none is named, say you are part of this business's Ark Team, from BlackArk",
    );
    expect(IDENTITY_GUIDANCE).toContain(
      "Never name the model you run on, its maker",
    );
    expect(IDENTITY_GUIDANCE).toContain("Inception");
  });

  test("it never denies not being a person, and answers in the question's language", () => {
    expect(IDENTITY_GUIDANCE).toContain(
      "say plainly that you are a digital employee, not a person",
    );
    expect(IDENTITY_GUIDANCE).toContain("in the language of the question");
  });
});
