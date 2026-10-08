/**
 * A long reply is stored as the thousands of one-character pieces it was streamed in. Someone opening
 * the conversation later is sent it as a few large pieces, with the same text and the same cursors.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { Socket } from "phoenix";
import type { HubConfig } from "../src/config";
import { type RunningHub, startHub } from "../src/server";
import { createTestDatabase, type TestDatabase } from "./support";

const API_KEY = "k".repeat(40);
const config: HubConfig = {
  port: 0,
  databaseUrl: "unused",
  apiKey: API_KEY,
  joinSecret: "j".repeat(40),
  joinTokenTtlSeconds: 3600,
  defaultLockTtlSeconds: 60,
  bus: "postgres",
};

let database: TestDatabase;
let running: RunningHub;
let intelligence: CopilotKitIntelligence;

beforeAll(async () => {
  database = await createTestDatabase();
  running = await startHub(config, { sql: database.sql });
  intelligence = new CopilotKitIntelligence({
    apiUrl: running.apiUrl,
    wsUrl: running.wsUrl,
    apiKey: API_KEY,
  });
});
afterAll(async () => {
  await running.stop();
  await database.drop();
});

const PIECES = 3000;
/** A character per piece, none of them the same as its neighbour, so a mixed-up order shows. */
const text = Array.from({ length: PIECES }, (_, i) =>
  String.fromCharCode(97 + (i % 26)),
).join("");

type Payload = Record<string, unknown> & {
  type: string;
  delta?: string;
  metadata?: { cpki_event_id?: string };
};

const withId = (id: string, event: Record<string, unknown>) => ({
  ...event,
  metadata: { cpki_event_id: id },
});

/** One run: a message streamed a character at a time, then another message, then the end. */
async function storeLongRun(threadId: string) {
  await intelligence.createThread({
    threadId,
    userId: "ann",
    agentId: "general",
  });
  const runId = "run-1";
  const base = { threadId, runId };
  const events: Payload[] = [
    withId("e-start", { type: "RUN_STARTED", ...base }) as Payload,
    withId("e-m1", {
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant",
    }) as Payload,
    ...Array.from(
      { length: PIECES },
      (_, i) =>
        withId(`e-p${i}`, {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m1",
          delta: text[i],
        }) as Payload,
    ),
    withId("e-m1-end", {
      type: "TEXT_MESSAGE_END",
      messageId: "m1",
    }) as Payload,
    withId("e-m2", {
      type: "TEXT_MESSAGE_START",
      messageId: "m2",
      role: "assistant",
    }) as Payload,
    withId("e-m2-a", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m2",
      delta: "tail ",
    }) as Payload,
    withId("e-m2-b", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m2",
      delta: "end",
    }) as Payload,
    withId("e-m2-end", {
      type: "TEXT_MESSAGE_END",
      messageId: "m2",
    }) as Payload,
    withId("e-finish", { type: "RUN_FINISHED", ...base }) as Payload,
  ];
  // The pieces are stored one at a time, as a runner sends them, not in one write.
  for (let from = 0; from < events.length; from += 250) {
    await running.hub.store.appendEvents(
      threadId,
      runId,
      events.slice(from, from + 250),
    );
  }
  return events;
}

/** Joins as the browser does and waits for the replay to be complete. */
async function replayFor(
  threadId: string,
  lastSeenEventId: string | null,
): Promise<{
  frames: Payload[];
  complete: { latest_event_id: string | null };
}> {
  const connection = await intelligence.ɵconnectThread({
    threadId,
    userId: "ann",
    agentId: "general",
  });
  const socket = new Socket(`${running.wsUrl}/client`, {
    params: { join_token: connection?.joinToken as string },
  });
  socket.connect();
  const channel = socket.channel(`thread:${threadId}`, {
    stream_mode: "connect",
    last_seen_event_id: lastSeenEventId,
  });
  const frames: Payload[] = [];
  channel.on("ag_ui_event", (payload: Payload) => {
    frames.push(payload);
  });
  const complete = new Promise<{ latest_event_id: string | null }>(
    (resolve) => {
      channel.on("replay_complete", resolve);
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      channel
        .join()
        .receive("ok", () => resolve())
        .receive("error", (response: unknown) =>
          reject(new Error(`join refused: ${JSON.stringify(response)}`)),
        );
    });
    const done = await Promise.race([
      complete,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("replay never completed")), 15_000),
      ),
    ]);
    return { frames, complete: done };
  } finally {
    channel.leave();
    socket.disconnect();
  }
}

const textOf = (frames: Payload[], messageId: string) =>
  frames
    .filter(
      (frame) =>
        frame.type === "TEXT_MESSAGE_CONTENT" && frame.messageId === messageId,
    )
    .map((frame) => frame.delta)
    .join("");

describe("replaying a long reply", () => {
  test("sends a few large pieces for thousands of small ones, with the same text in the same order", async () => {
    const threadId = "replay-long-1";
    const stored = await storeLongRun(threadId);
    const { frames, complete } = await replayFor(threadId, null);

    expect(textOf(frames, "m1")).toBe(text);
    expect(textOf(frames, "m2")).toBe("tail end");
    // Not the three thousand it was stored as.
    expect(frames.length).toBeLessThan(40);
    expect(frames.map((frame) => frame.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      ...frames
        .filter(
          (frame) =>
            frame.type === "TEXT_MESSAGE_CONTENT" && frame.messageId === "m1",
        )
        .map(() => "TEXT_MESSAGE_CONTENT"),
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    // The end of the replay still names the last thing stored, and so does the last thing sent.
    const lastStored = stored[stored.length - 1]?.metadata?.cpki_event_id;
    expect(complete.latest_event_id).toBe(lastStored as string);
    expect(frames[frames.length - 1]?.metadata?.cpki_event_id).toBe(
      lastStored as string,
    );
  });

  test("a large piece's cursor is one that can be resumed from", async () => {
    const threadId = "replay-long-2";
    await storeLongRun(threadId);
    const first = await replayFor(threadId, null);
    const pieces = first.frames.filter(
      (frame) =>
        frame.type === "TEXT_MESSAGE_CONTENT" && frame.messageId === "m1",
    );
    // Resume from the end of the large piece the browser was last sent.
    const cursor = pieces[pieces.length - 1]?.metadata?.cpki_event_id as string;
    expect(cursor).toBe("e-p2999");

    const resumed = await replayFor(threadId, cursor);
    // Only what came after it: the first message is over, and the second is whole.
    expect(resumed.frames.map((frame) => frame.type)).toEqual([
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(textOf(resumed.frames, "m2")).toBe("tail end");
  });

  test("a cursor in the middle of what was stored still resumes right after it", async () => {
    const threadId = "replay-long-3";
    await storeLongRun(threadId);
    // A cursor the browser could hold from live events: one stored piece, not a merged one.
    const { frames } = await replayFor(threadId, "e-p1499");
    // It is sent the rest of the first message, which is not repeated, then everything after it.
    expect(textOf(frames, "m1")).toBe(text.slice(1500));
    expect(textOf(frames, "m2")).toBe("tail end");
    expect(frames.length).toBeLessThan(40);
  });

  test("nothing is merged across a message, a run, or an event of another kind", async () => {
    const threadId = "replay-long-4";
    await storeLongRun(threadId);
    const { frames } = await replayFor(threadId, null);
    const starts = frames.filter(
      (frame) => frame.type === "TEXT_MESSAGE_START",
    );
    const ends = frames.filter((frame) => frame.type === "TEXT_MESSAGE_END");
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    // Every large piece belongs to exactly one message.
    for (const frame of frames) {
      if (frame.type === "TEXT_MESSAGE_CONTENT") {
        expect(["m1", "m2"]).toContain(frame.messageId as string);
      }
    }
  });
});
