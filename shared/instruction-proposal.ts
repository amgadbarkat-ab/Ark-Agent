/**
 * A proposed change to a trial employee's standing instruction (#116, item 2), as a file the
 * customer's administrator sends to BlackArk.
 *
 * WHY A FILE. On a trial install the standing instruction of every employee from the signed profile
 * is read-only: it changes only when BlackArk signs a new profile. An administrator who wants it
 * changed presses "Propose a change" and gets this file. BlackArk scores it against the employee's
 * test cases (`bun scripts/ark-eval.ts run --profile <customer>.json --proposed <this file>`) and, if
 * it is kept, signs a new profile. Nothing on the customer's computer changes until that arrives.
 *
 * THE FORMAT, version 1 (JSON, UTF-8, one object, nothing else in it):
 *
 *   {
 *     "v": 1,
 *     "employee": { "id": "b2b-orders", "name": "B2B Orders" },
 *     "current": "the standing instruction in force now",
 *     "proposed": "the text the administrator wants instead",
 *     "reason": "why, in the administrator's words",
 *     "createdAt": "2026-11-17T10:00:00.000Z",
 *     "appVersion": "0.1.47"
 *   }
 *
 * - `employee.id` is the employee's key in the signed trial profile (`roster[].key`), the name
 *   BlackArk knows it by; never the random id the install gave it. `employee.name` is for a person.
 * - `current` is what the employee runs on now, `proposed` what it should run on instead; they differ.
 * - `reason` is required: a change nobody can explain cannot be judged.
 * - `createdAt` is an ISO 8601 instant; `appVersion` is the ArkAgent release that made the file.
 *
 * WHAT IS NOT IN IT. No customer data beyond the employee's own instruction text: no conversation,
 * mail, file, person's name, install id or customer id. A reader refuses any field not listed above,
 * so nothing extra can ride along unnoticed, and a newer format is refused rather than misread.
 */

/** The only version this code writes and reads. */
export const PROPOSAL_VERSION = 1;

/** The longest instruction a trial profile may carry (`readProfile` in trial.ts). */
export const PROPOSAL_MAX_INSTRUCTION = 20_000;
export const PROPOSAL_MAX_REASON = 2_000;

export type InstructionProposal = {
  v: 1;
  /** `id` is the employee's key in the signed trial profile. */
  employee: { id: string; name: string };
  current: string;
  proposed: string;
  reason: string;
  createdAt: string;
  appVersion: string;
};

/** A proposal that is not well formed, in words a person reads. */
export class ProposalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalFormatError";
  }
}

/** The same rule as a trial profile's employee key. */
const EMPLOYEE_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELDS = [
  "v",
  "employee",
  "current",
  "proposed",
  "reason",
  "createdAt",
  "appVersion",
];

function text(value: unknown, missing: string, max: number, long: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProposalFormatError(missing);
  }
  if (value.trim().length > max) throw new ProposalFormatError(long);
  return value.trim();
}

/** A proposal's shape, checked. What `ark-eval run --proposed` reads, and what the app writes. */
export function readInstructionProposal(value: unknown): InstructionProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProposalFormatError("This is not a proposed change.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== PROPOSAL_VERSION) {
    throw new ProposalFormatError(
      "This proposed change is for a different version of ArkAgent.",
    );
  }
  const extra = Object.keys(raw).filter((field) => !FIELDS.includes(field));
  if (extra.length > 0) {
    throw new ProposalFormatError(
      `A proposed change holds only the fields of its format, not ${extra.join(", ")}.`,
    );
  }
  const employee = raw.employee as Record<string, unknown> | undefined;
  if (
    !employee ||
    typeof employee !== "object" ||
    Object.keys(employee).some((field) => field !== "id" && field !== "name")
  ) {
    throw new ProposalFormatError(
      "The proposed change does not say which employee it is for.",
    );
  }
  const id = text(
    employee.id,
    "The proposed change does not say which employee it is for.",
    40,
    "The proposed change's employee key is not valid.",
  );
  if (!EMPLOYEE_KEY.test(id)) {
    throw new ProposalFormatError(
      "The proposed change's employee key is not valid.",
    );
  }
  const name = text(
    employee.name,
    "The proposed change does not name the employee.",
    80,
    "The employee's name is too long.",
  );
  const current = text(
    raw.current,
    "The proposed change has no current instruction.",
    PROPOSAL_MAX_INSTRUCTION,
    "The current instruction is too long.",
  );
  const proposed = text(
    raw.proposed,
    "Write the new instruction.",
    PROPOSAL_MAX_INSTRUCTION,
    "The new instruction can be 20000 characters at most.",
  );
  if (proposed === current) {
    throw new ProposalFormatError(
      "The new instruction is the same as the current one.",
    );
  }
  const reason = text(
    raw.reason,
    "Say why the instruction should change.",
    PROPOSAL_MAX_REASON,
    "The reason can be 2000 characters at most.",
  );
  const createdRaw = text(
    raw.createdAt,
    "The proposed change has no date.",
    40,
    "The proposed change's date is not valid.",
  );
  const created = Date.parse(createdRaw);
  if (Number.isNaN(created)) {
    throw new ProposalFormatError("The proposed change's date is not valid.");
  }
  const appVersion = text(
    raw.appVersion,
    "The proposed change does not say which version of ArkAgent made it.",
    40,
    "The proposed change's version is not valid.",
  );
  return {
    v: PROPOSAL_VERSION,
    employee: { id, name },
    current,
    proposed,
    reason,
    createdAt: new Date(created).toISOString(),
    appVersion,
  };
}

/** A proposal file's text, read and checked. */
export function readInstructionProposalFile(
  fileText: string,
): InstructionProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText.replace(/^﻿/, ""));
  } catch {
    throw new ProposalFormatError("This file is not a proposed change.");
  }
  return readInstructionProposal(parsed);
}

/** A new proposal, checked the way a reader will check it. */
export function buildInstructionProposal(input: {
  employee: { id: string; name: string };
  current: string;
  proposed: string;
  reason: string;
  appVersion: string;
  now?: Date;
}): InstructionProposal {
  return readInstructionProposal({
    v: PROPOSAL_VERSION,
    employee: { id: input.employee.id, name: input.employee.name },
    current: input.current,
    proposed: input.proposed,
    reason: input.reason,
    createdAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion,
  });
}

/** The file's text: indented, so a person at BlackArk can read it as it is. */
export function proposalFileText(proposal: InstructionProposal): string {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

/** `proposed-change-b2b-orders-2026-11-17-1000.json`: the employee and the minute, in UTC. */
export function proposalFileName(proposal: InstructionProposal): string {
  const stamp = proposal.createdAt
    .slice(0, 16)
    .replace("T", "-")
    .replace(":", "");
  return `proposed-change-${proposal.employee.id}-${stamp}.json`;
}
