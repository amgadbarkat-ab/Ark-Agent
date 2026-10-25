import { describe, expect, test } from "bun:test";
import { CONVERSATION_GUIDANCE } from "../shared/bot-prompt";
import {
  checkCapabilities,
  checkGreeting,
  employees,
} from "./conversation-check";

const assistant = {
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday Work",
  prompt: "",
};

describe("a reply to How are you?", () => {
  test("a line or two passes", () => {
    expect(
      checkGreeting(
        "I'm well, thanks for asking. What can I help you with today?",
      ).ok,
    ).toBe(true);
  });

  test("the DT Lab's v0.1.14 answer fails: a tour of the platform and a summary", () => {
    const reply = [
      "I'm doing well, ready to help! Here's what I can do:",
      "- Browse the web and read pages",
      "- Work with files in my workspace",
      "- Draw dashboards, charts and forms",
      "Summary: I can help with research, files and reports.",
    ].join("\n");
    expect(checkGreeting(reply).ok).toBe(false);
  });

  test("a long paragraph fails even without a list", () => {
    expect(checkGreeting("Doing well. ".repeat(40)).ok).toBe(false);
  });
});

describe("a reply to What can you do?", () => {
  test("its own role passes", () => {
    expect(
      checkCapabilities(
        "As your General Assistant I help with everyday work: drafting, answering questions, summarising documents. Shall I start on something?",
        assistant,
      ).ok,
    ).toBe(true);
  });

  test("a platform tour that never says which role it is fails", () => {
    expect(
      checkCapabilities(
        "I can browse the web, work with files, render A2UI surfaces and build dashboards.",
        assistant,
      ).ok,
    ).toBe(false);
  });
});

test("every employee checked is prompted the way the server prompts it, conversation guidance included", async () => {
  const all = await employees();
  expect(all.length).toBeGreaterThan(10);
  expect(all.some((employee) => employee.id === "general-assistant")).toBe(
    true,
  );
  expect(all.some((employee) => employee.id === "operations-coordinator")).toBe(
    true,
  );
  for (const employee of all) {
    expect(employee.prompt).toContain(CONVERSATION_GUIDANCE);
  }
});
