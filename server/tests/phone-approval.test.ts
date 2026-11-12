import { describe, expect, test } from "bun:test";
import type { ApprovalRecord } from "../src/approvals/store";
import { answered, ended, MAX_PIN_TRIES, pressed } from "../src/phone/keypad";
import {
  e164,
  hashPin,
  phoneMayDecide,
  pinMatches,
} from "../src/phone/service";

const SUMMARY = "Call send_message on Gmail, which changes something there.";
const right = (pin: string) => pin === "2468";

describe("a phone approval call, key by key (P2 idea 10)", () => {
  test("nothing is said about the request before the right PIN", () => {
    const start = answered();
    expect(start.say).toContain("Enter your PIN");
    expect(start.say).not.toContain("Gmail");
    const wrong = pressed(start.state, "1111#", SUMMARY, right);
    expect(wrong.state).toEqual({ step: "pin", tries: 1 });
    expect(wrong.say).not.toContain("Gmail");
    const ok = pressed(start.state, "2468#", SUMMARY, right);
    expect(ok.state).toEqual({ step: "choose" });
    expect(ok.say).toContain(SUMMARY);
    expect(ok.say).toContain("Press 1 to approve");
  });

  test("three wrong PINs end the call without deciding", () => {
    let state = answered().state;
    for (let index = 0; index < MAX_PIN_TRIES; index++) {
      state = pressed(state, "0000#", SUMMARY, right).state;
    }
    expect(state).toEqual({ step: "ended", outcome: "pin-failed" });
  });

  test("1 approves, 2 declines, 3 leaves it for the app, anything else repeats", () => {
    const choose = { step: "choose" } as const;
    expect(pressed(choose, "1", SUMMARY, right).state).toEqual({
      step: "ended",
      outcome: "approved",
    });
    expect(pressed(choose, "2", SUMMARY, right).state).toEqual({
      step: "ended",
      outcome: "declined",
    });
    expect(pressed(choose, "3", SUMMARY, right).state).toEqual({
      step: "ended",
      outcome: "later",
    });
    expect(pressed(choose, "9", SUMMARY, right).state).toEqual(choose);
  });

  test("an unanswered or hung-up call is not an approval", () => {
    expect(ended({ step: "ringing" }).state).toEqual({
      step: "ended",
      outcome: "no-answer",
    });
    expect(ended({ step: "choose" }).state).toEqual({
      step: "ended",
      outcome: "hung-up",
    });
  });
});

function record(over: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: "a1",
    ownerUserId: "u1",
    requestedByAgentId: "b1",
    requestedByName: "Order Desk",
    kind: "tool.call",
    targetAgentId: null,
    targetAgentName: null,
    targetId: "google-gmail/send_message",
    summary: SUMMARY,
    payload: {
      server: "google-gmail",
      tool: "send_message",
      args: { to: "a@b.gr" },
    },
    status: "pending",
    result: null,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    threadId: null,
    runId: null,
    channelId: null,
    ...over,
  };
}

describe("what a phone may never decide (Amgad's rule, desk #90)", () => {
  test("a browser or computer action (device control) is never decided by phone", () => {
    expect(phoneMayDecide(record({ kind: "computer.action" }))).toBe(
      "device-control",
    );
  });

  test("anything that moves money is never decided by phone", () => {
    expect(
      phoneMayDecide(
        record({
          payload: { server: "stripe", tool: "create_charge", args: {} },
        }),
      ),
    ).toBe("payment");
    expect(
      phoneMayDecide(
        record({
          kind: "chat.card",
          summary: "Refund this order?",
          payload: { title: "Refund" },
        }),
      ),
    ).toBe("payment");
    expect(
      phoneMayDecide(
        record({
          payload: { tool: "send_message", args: { body: "Total €128.40" } },
        }),
      ),
    ).toBe("payment");
  });

  test("a change to a colleague's work is approved in the app only", () => {
    expect(phoneMayDecide(record({ kind: "routine.update" }))).toBe("kind");
  });

  test("an ordinary send may be", () => {
    expect(phoneMayDecide(record({}))).toBeNull();
  });
});

describe("the PIN and the number", () => {
  test("the PIN is stored hashed and salted, and only the right one matches", () => {
    const stored = hashPin("2468");
    expect(stored).not.toContain("2468");
    expect(stored).not.toBe(hashPin("2468"));
    expect(pinMatches(stored, "2468")).toBe(true);
    expect(pinMatches(stored, "2469")).toBe(false);
    expect(pinMatches("plain", "2468")).toBe(false);
  });

  test("a number needs its country code", () => {
    expect(e164("+30 691 234 5678")).toBe("+306912345678");
    expect(e164("6912345678")).toBeNull();
  });
});
