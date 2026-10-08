import type { StoredEvent } from "./store";

/**
 * Fewer, larger events for replay.
 *
 * A model streams its answer a few characters at a time, and each piece is stored as an event of its
 * own, so a long conversation is tens of thousands of events that a browser joining it has to be sent
 * and apply one by one. Consecutive pieces of the same message say exactly what their concatenation
 * says, to any client that applies them in order, so on replay they are sent as one.
 *
 * ONLY WHAT IS PROVABLY THE SAME. Adjacent events, of one type, naming the same message (or tool call),
 * from the same run, each with a text `delta`. Anything between two pieces (another event, another
 * message, the end of the run) keeps them apart, and nothing else is touched: starts, ends, tool
 * results, state and the run's own markers go through exactly as stored.
 *
 * The merged event takes the LAST piece's identity (its id, its sequence number and its metadata)
 * because a client remembers the id of the newest event it has seen and asks to resume after it.
 * Resuming after a merged event is therefore the same as resuming after the real one it ended with,
 * and a client that left in the middle of a stretch still resumes from an event that exists.
 *
 * Replay only. Events sent live are sent as they happen, one by one.
 */

/** Which field says what the delta belongs to, or null where consecutive ones always belong together. */
const MERGEABLE: Record<string, string | null> = {
  TEXT_MESSAGE_CONTENT: "messageId",
  TOOL_CALL_ARGS: "toolCallId",
  REASONING_MESSAGE_CONTENT: "messageId",
  THINKING_TEXT_MESSAGE_CONTENT: null,
};

/** Characters in one merged delta, so a single frame stays a sensible size. */
const MAX_MERGED_CHARACTERS = 32_000;

function mergeable(first: StoredEvent, next: StoredEvent): boolean {
  const type = first.payload.type;
  if (!type || type !== next.payload.type || !(type in MERGEABLE)) return false;
  if (first.runId !== next.runId) return false;
  const a = first.payload.delta;
  const b = next.payload.delta;
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length + b.length > MAX_MERGED_CHARACTERS) return false;
  const key = MERGEABLE[type];
  if (key === null || key === undefined) return true;
  const left = first.payload[key];
  const right = next.payload[key];
  return typeof left === "string" && left !== "" && left === right;
}

export function coalesce(events: readonly StoredEvent[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  for (const event of events) {
    const previous = out.at(-1);
    if (previous && mergeable(previous, event)) {
      out[out.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          delta: `${previous.payload.delta as string}${event.payload.delta as string}`,
        },
      };
    } else {
      out.push(event);
    }
  }
  return out;
}
