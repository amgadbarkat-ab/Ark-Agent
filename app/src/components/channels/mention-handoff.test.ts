import { expect, test } from "bun:test";
import {
  addressedOutside,
  handoffInstruction,
  mentionedColleague,
} from "./mention-handoff";

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

/*
 * The owner typed "@Chief of Operations who are you and what is your role" into a conversation that
 * had started with somebody else, and that somebody answered "I'm the same digital employee as
 * before, not a Chief of Operations" (v0.1.16).
 */
test("an @ for somebody outside the conversation names them, typed or chosen", () => {
  const everyone = [...members, { id: "general", name: "General Assistant" }];
  expect(
    addressedOutside(
      {
        text: "@Chief of Operations who are you and what is your role",
        agentId: null,
      },
      everyone,
      ["general"],
    )?.id,
  ).toBe("chief");
  expect(
    addressedOutside({ text: "who are you", agentId: "chief" }, everyone, [
      "general",
    ])?.id,
  ).toBe("chief");
});

test("an @ for somebody already in the conversation is not outside it", () => {
  expect(
    addressedOutside(
      { text: "@Marketing a new website", agentId: null },
      members,
      ["chief", "marketing"],
    ),
  ).toBeNull();
  expect(
    addressedOutside(
      { text: "an email address a@b.com", agentId: null },
      members,
      ["chief"],
    ),
  ).toBeNull();
});
