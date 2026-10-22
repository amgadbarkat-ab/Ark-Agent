import { expect, test } from "bun:test";
import { handoffInstruction, mentionedColleague } from "./mention-handoff";

const members = [
  { id: "chief", name: "Chief of Operations" },
  { id: "marketing", name: "Marketing" },
  { id: "sales", name: "Sales" },
  { id: "sales-lead", name: "Sales Lead" },
];

test("an @ chip names the colleague the message is for", () => {
  expect(
    mentionedColleague(
      { text: "@Marketing a new website", agentId: "marketing" },
      members,
      "chief",
    ),
  ).toEqual({ id: "marketing", name: "Marketing" });
});

test("an @Name typed out is read too, whatever its case", () => {
  expect(
    mentionedColleague(
      { text: "@marketing can i give you a task", agentId: null },
      members,
      "chief",
    )?.id,
  ).toBe("marketing");
  expect(
    mentionedColleague(
      { text: "ask @Sales Lead about it", agentId: null },
      members,
      "chief",
    )?.id,
  ).toBe("sales-lead");
  expect(
    mentionedColleague(
      { text: "ask @Sales about it", agentId: null },
      members,
      "chief",
    )?.id,
  ).toBe("sales");
});

test("a message to the lead, or to nobody, needs no hand-off", () => {
  expect(
    mentionedColleague(
      { text: "@Chief of Operations hi", agentId: "chief" },
      members,
      "chief",
    ),
  ).toBeNull();
  expect(
    mentionedColleague({ text: "hi", agentId: null }, members, "chief"),
  ).toBeNull();
  expect(
    mentionedColleague(
      { text: "@Marketingteam", agentId: null },
      members,
      "chief",
    ),
  ).toBeNull();
  expect(
    mentionedColleague(
      { text: "@Finance", agentId: "finance" },
      members,
      "chief",
    ),
  ).toBeNull();
});

test("the lead is told who it was for and how to pass it on", () => {
  const said = handoffInstruction({ id: "marketing", name: "Marketing" });
  expect(said).toContain("team_ask");
  expect(said).toContain("@Marketing");
  expect(said).toContain("Do not answer it yourself");
});
