import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  budgetFromEnvironment,
  DEFAULT_BUDGET,
  economise,
} from "../src/history-budget";

type Message = RunAgentInput["messages"][number];

const user = (id: string, content = id): Message =>
  ({ id, role: "user", content }) as Message;
const assistant = (id: string, toolCallId?: string): Message =>
  ({
    id,
    role: "assistant",
    content: id,
    ...(toolCallId
      ? {
          toolCalls: [
            {
              id: toolCallId,
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        }
      : {}),
  }) as Message;
const result = (toolCallId: string, content: string): Message =>
  ({ id: `r-${toolCallId}`, role: "tool", toolCallId, content }) as Message;
const standing = (): Message =>
  ({
    id: "standing-role:a",
    role: "system",
    content: "You are Ana.",
  }) as Message;

const unlimited = { turns: 0, characters: 0, toolResultCharacters: 0 };

describe("economise", () => {
  test("leaves a short conversation exactly as it was", () => {
    const messages = [standing(), user("u1"), assistant("a1")];
    expect(economise(messages, DEFAULT_BUDGET)).toEqual({
      messages,
      omitted: 0,
    });
  });

  test("keeps only the latest turns and always the standing role", () => {
    const messages = [
      standing(),
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
    ];
    const { messages: kept, omitted } = economise(messages, {
      ...unlimited,
      turns: 2,
    });
    const ids = kept.map((message) => message.id);
    expect(ids).toContain("standing-role:a");
    expect(ids).not.toContain("u1");
    expect(ids).not.toContain("a1");
    expect(ids).toContain("u2");
    expect(ids).toContain("u3");
    expect(omitted).toBe(2);
  });

  test("says what was left out, after the standing role and before the first turn shown", () => {
    const { messages } = economise(
      [standing(), user("u1"), assistant("a1"), user("u2")],
      { ...unlimited, turns: 1 },
    );
    expect(messages.map((message) => message.id)).toEqual([
      "standing-role:a",
      "history-omitted",
      "u2",
    ]);
    expect(String(messages[1]?.content)).toContain("Do not guess");
  });

  test("never separates a tool call from its result", () => {
    const messages = [
      user("u1"),
      assistant("a1", "c1"),
      result("c1", "x"),
      user("u2"),
    ];
    const { messages: kept } = economise(messages, { ...unlimited, turns: 1 });
    const ids = kept.map((message) => message.id);
    expect(ids).not.toContain("a1");
    expect(ids).not.toContain("r-c1");
  });

  test("shortens a tool result from an earlier turn but not from the current one", () => {
    const long = "y".repeat(5_000);
    const { messages: kept } = economise(
      [
        user("u1"),
        assistant("a1", "c1"),
        result("c1", long),
        user("u2"),
        assistant("a2", "c2"),
        result("c2", long),
      ],
      { ...unlimited, toolResultCharacters: 100 },
    );
    const earlier = String(kept.find((m) => m.id === "r-c1")?.content);
    const current = String(kept.find((m) => m.id === "r-c2")?.content);
    expect(earlier.length).toBeLessThan(300);
    expect(earlier).toContain("4900 more characters");
    expect(current).toBe(long);
  });

  test("drops the oldest turns until the budget is met, but never the last one", () => {
    const big = "z".repeat(10_000);
    const { messages: kept } = economise(
      [user("u1", big), user("u2", big), user("u3", big)],
      { ...unlimited, characters: 15_000 },
    );
    const ids = kept.map((message) => message.id);
    expect(ids).toContain("u3");
    expect(ids).not.toContain("u1");

    const only = economise([user("u1", big)], { ...unlimited, characters: 10 });
    expect(only.messages.map((message) => message.id)).toEqual(["u1"]);
  });
});

describe("budgetFromEnvironment", () => {
  test("uses the defaults when nothing is set", () => {
    expect(budgetFromEnvironment({})).toEqual(DEFAULT_BUDGET);
  });

  test("reads whole numbers, and zero switches a limit off", () => {
    expect(
      budgetFromEnvironment({
        BOT_HISTORY_TURNS: "0",
        BOT_HISTORY_CHARACTERS: "1000",
        BOT_TOOL_RESULT_CHARACTERS: "50",
      }),
    ).toEqual({ turns: 0, characters: 1000, toolResultCharacters: 50 });
  });

  test("ignores anything that is not a whole number", () => {
    expect(
      budgetFromEnvironment({
        BOT_HISTORY_TURNS: "lots",
        BOT_HISTORY_CHARACTERS: "-4",
        BOT_TOOL_RESULT_CHARACTERS: "1.5",
      }),
    ).toEqual(DEFAULT_BUDGET);
  });
});

describe("toProviderMessages", () => {
  test("shows the model the recent turns and the standing role, and says what it left out", async () => {
    const { toProviderMessages } = await import("../src/history");
    const turns = Array.from({ length: 6 }, (_, index) => [
      user(`u${index}`, `question ${index}`),
      assistant(`a${index}`),
    ]).flat();
    const provider = toProviderMessages(
      {
        threadId: "t",
        runId: "r",
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
        messages: [standing(), ...turns],
      } as unknown as RunAgentInput,
      { turns: 2, characters: 0, toolResultCharacters: 0 },
    );
    const text = provider.map((message) => String(message.content));
    expect(text.some((line) => line.includes("You are Ana."))).toBe(true);
    expect(text.some((line) => line.includes("question 5"))).toBe(true);
    expect(text.some((line) => line.includes("question 0"))).toBe(false);
    expect(text.some((line) => line.includes("Do not guess"))).toBe(true);
  });
});
