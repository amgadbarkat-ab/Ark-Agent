/**
 * A proposed change to one trial employee's standing instruction (#116).
 *
 * WHO MAKES ONE. A person (an administrator asking BlackArk for a change) or `ark-eval tune` after a
 * person approved that proposal. Either way it is only a request: nothing on a customer's computer
 * changes until BlackArk scores it (`bun scripts/ark-eval.ts run --proposed <file>`), a person
 * accepts the result, and a newly signed profile arrives.
 *
 * WHAT IT HOLDS. The customer and employee it is for, and the whole new instruction text. Tool notes
 * for an employee live in that instruction (the profile has no separate field for them), so this is
 * also how a change to what the employee is told about its tools travels.
 */
import { TrialFormatError, type TrialProfile } from "./trial";

export const CHANGE_FORMAT = "arkchange/1";

export type ProposedChange = {
  format: typeof CHANGE_FORMAT;
  /** The profile's `customer.id`. */
  customer: string;
  /** The roster entry's `key`. */
  employee: string;
  /** The whole new standing instruction, not a diff. */
  instructions: string;
  /** Who or what made it: a person's request or an approved `tune` proposal. */
  source?: "person" | "tune";
  /** In a sentence or two, what changes and why. */
  summary?: string;
  createdAt?: string;
};

/** A change file's contents, checked against the profile it is meant for. */
export function readProposedChange(
  value: unknown,
  profile: TrialProfile,
): ProposedChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrialFormatError("This is not a proposed change.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.format !== CHANGE_FORMAT) {
    throw new TrialFormatError(
      `This is not a proposed change: its format should be "${CHANGE_FORMAT}".`,
    );
  }
  if (raw.customer !== profile.customer.id) {
    throw new TrialFormatError(
      `This change is for the customer "${String(raw.customer)}", not "${profile.customer.id}".`,
    );
  }
  const employee = profile.roster.find((entry) => entry.key === raw.employee);
  if (!employee) {
    throw new TrialFormatError(
      `This change is for the employee "${String(raw.employee)}", who is not in the profile.`,
    );
  }
  if (typeof raw.instructions !== "string" || !raw.instructions.trim()) {
    throw new TrialFormatError("This change has no new instruction.");
  }
  if (raw.instructions.length > 20_000) {
    throw new TrialFormatError("This change's instruction is too long.");
  }
  if (raw.instructions.trim() === employee.instructions) {
    throw new TrialFormatError(
      "This change's instruction is the same as the current one.",
    );
  }
  const source =
    raw.source === "person" || raw.source === "tune" ? raw.source : undefined;
  const summary =
    typeof raw.summary === "string" && raw.summary.trim()
      ? raw.summary.trim().slice(0, 2000)
      : undefined;
  const createdAt =
    typeof raw.createdAt === "string" &&
    !Number.isNaN(Date.parse(raw.createdAt))
      ? new Date(Date.parse(raw.createdAt)).toISOString()
      : undefined;
  return {
    format: CHANGE_FORMAT,
    customer: profile.customer.id,
    employee: employee.key,
    instructions: raw.instructions.trim(),
    ...(source ? { source } : {}),
    ...(summary ? { summary } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}
