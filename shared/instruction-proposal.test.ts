import { describe, expect, test } from "bun:test";
import {
  buildInstructionProposal,
  ProposalFormatError,
  proposalFileName,
  proposalFileText,
  readInstructionProposal,
  readInstructionProposalFile,
} from "./instruction-proposal";

const input = {
  employee: { id: "front-desk", name: "Front Desk" },
  current: "Draft every reply for approval.",
  proposed: "Draft every reply for approval. Always ask for the order number.",
  reason: "Customers often forget to give the order number.",
  appVersion: "0.1.47",
  now: new Date("2026-11-17T10:05:30Z"),
};

describe("a proposed change to a standing instruction (#116)", () => {
  test("is built with exactly the fields of version 1, and nothing else", () => {
    const proposal = buildInstructionProposal(input);
    expect(proposal).toEqual({
      v: 1,
      employee: { id: "front-desk", name: "Front Desk" },
      current: "Draft every reply for approval.",
      proposed:
        "Draft every reply for approval. Always ask for the order number.",
      reason: "Customers often forget to give the order number.",
      createdAt: "2026-11-17T10:05:30.000Z",
      appVersion: "0.1.47",
    });
    expect(Object.keys(proposal).sort()).toEqual(
      [
        "appVersion",
        "createdAt",
        "current",
        "employee",
        "proposed",
        "reason",
        "v",
      ].sort(),
    );
  });

  test("its file reads back as the same proposal, and is named after the employee and the minute", () => {
    const proposal = buildInstructionProposal(input);
    const text = proposalFileText(proposal);
    expect(text.endsWith("\n")).toBe(true);
    expect(readInstructionProposalFile(text)).toEqual(proposal);
    // A file saved by an editor that adds a byte-order mark still reads.
    expect(readInstructionProposalFile(`﻿${text}`)).toEqual(proposal);
    expect(proposalFileName(proposal)).toBe(
      "proposed-change-front-desk-2026-11-17-1005.json",
    );
  });

  test("text is trimmed, and the date is written as UTC", () => {
    const proposal = readInstructionProposal({
      v: 1,
      employee: { id: "front-desk", name: "  Front Desk " },
      current: " a ",
      proposed: " b\n",
      reason: " why ",
      createdAt: "2026-11-17T12:00:00+02:00",
      appVersion: "0.1.47",
    });
    expect(proposal).toMatchObject({
      employee: { name: "Front Desk" },
      current: "a",
      proposed: "b",
      reason: "why",
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });

  test("refuses what is not a well-formed proposal, saying what is wrong", () => {
    const good = buildInstructionProposal(input);
    const refused = (value: unknown, words: string) => {
      expect(() => readInstructionProposal(value)).toThrow(ProposalFormatError);
      expect(() => readInstructionProposal(value)).toThrow(words);
    };
    refused(null, "not a proposed change");
    refused([good], "not a proposed change");
    refused({ ...good, v: 2 }, "different version");
    refused({ ...good, proposed: good.current }, "same as the current one");
    refused({ ...good, proposed: "  " }, "Write the new instruction");
    refused({ ...good, reason: "" }, "Say why");
    refused(
      { ...good, employee: { id: "Front Desk", name: "x" } },
      "key is not valid",
    );
    refused({ ...good, employee: undefined }, "which employee");
    refused({ ...good, createdAt: "yesterday" }, "date is not valid");
    refused({ ...good, appVersion: "" }, "which version");
    refused(
      { ...good, proposed: "x".repeat(20_001) },
      "20000 characters at most",
    );
    // Nothing rides along: no customer, no install, no conversation.
    refused({ ...good, customerId: "demo-shop" }, "not customerId");
    refused(
      { ...good, employee: { ...good.employee, agentId: "agent-1" } },
      "which employee",
    );
    expect(() => readInstructionProposalFile("not json")).toThrow(
      "not a proposed change",
    );
  });
});
