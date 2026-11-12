import { describe, expect, test } from "bun:test";
import { waitingHere } from "@/components/approvals/conversation-requests";
import type { ApprovalRecord } from "@/lib/approvals/queries";

function row(over: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: "a1",
    kind: "tool.call",
    summary: "Call send_message on Gmail, which changes something there.",
    status: "pending",
    result: null,
    requestedBy: { id: "bot", name: "Order Desk" },
    target: null,
    channelId: "c1",
    createdAt: "2026-11-12T08:00:00Z",
    expiresAt: "2026-11-13T08:00:00Z",
    decidedAt: null,
    ...over,
  };
}

describe("requests shown in a conversation (#83: no card for a held Gmail send)", () => {
  test("a held tool call asked in this conversation is shown here", () => {
    expect(waitingHere([row({})], "c1").map((r) => r.id)).toEqual(["a1"]);
  });

  test("a held browser action is shown too", () => {
    expect(waitingHere([row({ kind: "computer.action" })], "c1")).toHaveLength(
      1,
    );
  });

  test("another conversation's, a decided one, and one asked nowhere are not", () => {
    expect(
      waitingHere(
        [
          row({ id: "other", channelId: "c2" }),
          row({ id: "done", status: "approved" }),
          row({ id: "nowhere", channelId: null }),
        ],
        "c1",
      ),
    ).toEqual([]);
  });

  test("an employee's own approval card is left to the transcript, which already draws it", () => {
    expect(waitingHere([row({ kind: "chat.card" })], "c1")).toEqual([]);
  });
});
