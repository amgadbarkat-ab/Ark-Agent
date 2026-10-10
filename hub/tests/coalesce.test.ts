import { describe, expect, test } from "bun:test";
import { coalesce } from "../src/coalesce";
import type { StoredEvent } from "../src/store";

let seq = 0;
const event = (
  type: string,
  fields: Record<string, unknown> = {},
  runId: string | null = "run-1",
): StoredEvent => {
  seq += 1;
  return {
    seq,
    eventId: `e${seq}`,
    runId,
    payload: { type, ...fields, metadata: { cpki_event_id: `e${seq}` } },
  };
};
const delta = (
  messageId: string,
  text: string,
  runId: string | null = "run-1",
) => event("TEXT_MESSAGE_CONTENT", { messageId, delta: text }, runId);

describe("coalescing streamed pieces for replay", () => {
  test("consecutive pieces of one message become one, with the same text", () => {
    const pieces = ["Hel", "lo", ", ", "wor", "ld"].map((t) => delta("m1", t));
    const merged = coalesce(pieces);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload.delta).toBe("Hello, world");
  });

  test("the merged event is the last piece's: its id, sequence and metadata, so a cursor resumes correctly", () => {
    const pieces = ["a", "b", "c"].map((t) => delta("m1", t));
    const [only] = coalesce(pieces);
    expect(only?.seq).toBe(pieces[2]?.seq);
    expect(only?.eventId).toBe(pieces[2]?.eventId);
    const metadata = only?.payload.metadata as
      | { cpki_event_id: string }
      | undefined;
    expect(metadata?.cpki_event_id).toBe(pieces[2]?.eventId as string);
  });

  test("everything that is not a streamed piece goes through exactly as stored, in order", () => {
    const events = [
      event("RUN_STARTED", { runId: "run-1" }),
      event("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      delta("m1", "hi "),
      delta("m1", "there"),
      event("TEXT_MESSAGE_END", { messageId: "m1" }),
      event("TOOL_CALL_START", { toolCallId: "t1", toolCallName: "x" }),
      event("TOOL_CALL_ARGS", { toolCallId: "t1", delta: '{"a"' }),
      event("TOOL_CALL_ARGS", { toolCallId: "t1", delta: ":1}" }),
      event("TOOL_CALL_END", { toolCallId: "t1" }),
      event("TOOL_CALL_RESULT", { toolCallId: "t1", content: "ok" }),
      event("RUN_FINISHED", { runId: "run-1" }),
    ];
    const merged = coalesce(events);
    expect(merged.map((e) => e.payload.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
    expect(merged[2]?.payload.delta).toBe("hi there");
    expect(merged[5]?.payload.delta).toBe('{"a":1}');
    // The others are the very objects that were stored.
    expect(merged[0]).toBe(events[0]);
    expect(merged[7]).toBe(events[9]);
  });

  test("pieces of different messages, or separated by anything, are not joined", () => {
    const events = [
      delta("m1", "a"),
      delta("m2", "b"),
      delta("m1", "c"),
      event("CUSTOM", { name: "x", value: 1 }),
      delta("m1", "d"),
    ];
    expect(
      coalesce(events).map((e) => e.payload.delta ?? e.payload.name),
    ).toEqual(["a", "b", "c", "x", "d"]);
  });

  test("pieces from different runs are not joined", () => {
    const merged = coalesce([
      delta("m1", "a", "run-1"),
      delta("m1", "b", "run-2"),
    ]);
    expect(merged).toHaveLength(2);
  });

  test("a piece with no message, or no text, is left alone", () => {
    const events = [
      event("TEXT_MESSAGE_CONTENT", { delta: "a" }),
      event("TEXT_MESSAGE_CONTENT", { delta: "b" }),
      event("TEXT_MESSAGE_CONTENT", { messageId: "m1" }),
      event("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: 5 }),
    ];
    expect(coalesce(events)).toHaveLength(4);
  });

  test("thinking pieces, which name nothing, join when adjacent", () => {
    const merged = coalesce([
      event("THINKING_TEXT_MESSAGE_CONTENT", { delta: "hm" }),
      event("THINKING_TEXT_MESSAGE_CONTENT", { delta: "m..." }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload.delta).toBe("hmm...");
  });

  test("one frame stays a sensible size: a very long message becomes several", () => {
    const pieces = Array.from({ length: 100 }, () =>
      delta("m1", "x".repeat(1000)),
    );
    const merged = coalesce(pieces);
    expect(merged.length).toBeGreaterThan(1);
    expect(merged.length).toBeLessThan(10);
    for (const part of merged) {
      expect((part.payload.delta as string).length).toBeLessThanOrEqual(32_000);
    }
    expect(merged.map((m) => m.payload.delta).join("")).toBe(
      "x".repeat(100_000),
    );
  });

  test("nothing in, nothing out; the input is not changed", () => {
    expect(coalesce([])).toEqual([]);
    const original = [delta("m1", "a"), delta("m1", "b")];
    const copy = structuredClone(original);
    coalesce(original);
    expect(original).toEqual(copy);
  });
});
