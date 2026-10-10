import { describe, expect, test } from "bun:test";
import { foldMessages } from "../src/fold";

describe("foldMessages", () => {
  test("takes the person's messages from the run's input and the reply from its stream", () => {
    const messages = foldMessages([
      {
        type: "RUN_STARTED",
        input: { messages: [{ id: "u1", role: "user", content: "hi" }] },
      },
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "Hel" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "lo" },
      { type: "TEXT_MESSAGE_END", messageId: "a1" },
      { type: "RUN_FINISHED" },
    ]);
    expect(messages).toEqual([
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "Hello" },
    ]);
  });

  test("does not duplicate an input message a later run repeats", () => {
    const run = (extra: string) => [
      {
        type: "RUN_STARTED",
        input: {
          messages: [
            { id: "u1", role: "user", content: "hi" },
            ...(extra ? [{ id: extra, role: "user", content: extra }] : []),
          ],
        },
      },
    ];
    const messages = foldMessages([...run(""), ...run("u2")]);
    expect(messages.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  test("assembles a tool call and its result", () => {
    const messages = foldMessages([
      { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "c1",
        toolCallName: "browse",
        parentMessageId: "a1",
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"url":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '"x"}' },
      { type: "TOOL_CALL_END", toolCallId: "c1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "t1",
        toolCallId: "c1",
        content: "done",
      },
    ]);
    expect(messages).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "browse", args: '{"url":"x"}' }],
      },
      { id: "t1", role: "tool", content: "done", toolCallId: "c1" },
    ]);
  });

  test("creates the assistant message a tool call hangs from when no text came first", () => {
    const messages = foldMessages([
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "x" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: "{}" },
    ]);
    expect(messages).toEqual([
      {
        id: "c1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "x", args: "{}" }],
      },
    ]);
  });

  test("a snapshot replaces everything before it", () => {
    const messages = foldMessages([
      { type: "TEXT_MESSAGE_START", messageId: "old", role: "assistant" },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "s1", role: "user", content: "kept" }],
      },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "n1", delta: "after" },
    ]);
    expect(messages.map((m) => m.id)).toEqual(["s1", "n1"]);
  });

  test("keeps an activity as its own message and replaces it on a new snapshot", () => {
    const messages = foldMessages([
      {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "act",
        activityType: "plan",
        content: { step: 1 },
      },
      {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "act",
        activityType: "plan",
        content: { step: 2 },
      },
    ]);
    expect(messages).toEqual([
      {
        id: "act",
        role: "activity",
        activityType: "plan",
        content: { step: 2 },
      },
    ]);
  });
});
