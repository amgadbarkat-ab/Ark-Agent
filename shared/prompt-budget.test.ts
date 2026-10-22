import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  leftOutNote,
  narrowTools,
  windowFromEnvironment,
} from "./prompt-budget";

type Tool = RunAgentInput["tools"][number];
type Message = RunAgentInput["messages"][number];

const tool = (name: string): Tool => ({
  name,
  description: "d".repeat(500),
  parameters: { type: "object", properties: {} },
});
const person = (content: string) =>
  ({ id: "u", role: "user", content }) as Message;

const TOOLS = [
  "computer_navigate",
  "computer_read",
  "computer_write_file",
  "showBarChart",
  "showTable",
  "save_bot",
  "team_ask",
].map(tool);
const DEPLOYMENT = new Set(["team_ask"]);
const names = (list: Tool[]) => list.map((t) => t.name);

describe("a small window", () => {
  test("is offered only the tools a greeting needs", () => {
    const { offered, leftOut } = narrowTools(
      TOOLS,
      DEPLOYMENT,
      [person("hi")],
      1500,
    );
    expect(names(offered)).toEqual([
      "computer_navigate",
      "computer_read",
      "team_ask",
    ]);
    expect(leftOut).toEqual([
      "computer_write_file",
      "showBarChart",
      "showTable",
      "save_bot",
    ]);
  });

  test("is offered a group when the person asks about it", () => {
    const { offered } = narrowTools(
      TOOLS,
      DEPLOYMENT,
      [person("Show me a chart of sales")],
      1500,
    );
    expect(names(offered)).toContain("showBarChart");
    expect(names(offered)).not.toContain("save_bot");
  });

  test("reads Greek with or without accents", () => {
    for (const text of ["φτιάξε ένα γράφημα", "φτιαξε ενα γραφημα"]) {
      const { offered } = narrowTools(TOOLS, DEPLOYMENT, [person(text)], 1500);
      expect(names(offered)).toContain("showBarChart");
    }
  });

  test("keeps a group the thread has already used", () => {
    const messages = [
      person("save the notes"),
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c",
            type: "function",
            function: { name: "computer_write_file", arguments: "{}" },
          },
        ],
      } as Message,
      person("thanks"),
    ];
    const { offered } = narrowTools(TOOLS, DEPLOYMENT, messages, 1500);
    expect(names(offered)).toContain("computer_write_file");
  });

  test("never drops a tool the deployment runs, even one named like a chart", () => {
    const tools = [...TOOLS, tool("showActivityReport")];
    const { offered } = narrowTools(
      tools,
      new Set([...DEPLOYMENT, "showActivityReport"]),
      [person("hi")],
      1500,
    );
    expect(names(offered)).toContain("showActivityReport");
  });
});

test("everything is offered when the window is not known, or the tools fit", () => {
  expect(
    narrowTools(TOOLS, DEPLOYMENT, [person("hi")], undefined).offered,
  ).toEqual(TOOLS);
  expect(
    narrowTools(TOOLS, DEPLOYMENT, [person("hi")], 1_000_000).leftOut,
  ).toEqual([]);
});

test("the window is read from BOT_CONTEXT_TOKENS", () => {
  expect(windowFromEnvironment({ BOT_CONTEXT_TOKENS: "32768" })).toBe(32768);
  expect(windowFromEnvironment({ BOT_CONTEXT_TOKENS: "" })).toBeUndefined();
  expect(windowFromEnvironment({ BOT_CONTEXT_TOKENS: "nope" })).toBeUndefined();
  expect(windowFromEnvironment({ BOT_CONTEXT_TOKENS: "0" })).toBeUndefined();
  expect(windowFromEnvironment({})).toBeUndefined();
});

test("the model is told what it was not given", () => {
  const note = leftOutNote(["showBarChart", "save_bot"]);
  expect(note).toContain("not offered on this turn");
  expect(note).toContain("showBarChart, save_bot");
});
