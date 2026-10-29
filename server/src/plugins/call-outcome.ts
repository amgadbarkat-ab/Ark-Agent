import type { AuditInitiator } from "../audit";

/**
 * What happens when a digital employee calls one tool: it runs, a person approves it first, or it is
 * refused.
 *
 * The grant says whether a digital employee may hold a tool at all, and the boundary rules say
 * whether a particular call is permitted. Neither could say "yes, but a person looks at it first",
 * which is the answer an owner wants for most actions that send, pay, delete or change a record: the
 * employee should be able to prepare them, and a person should be the one who lets them go. This is
 * that third answer, set per tool on the tool's own screen.
 */
export type ToolCallOutcome = "allow" | "ask" | "refuse";

export const TOOL_CALL_OUTCOMES: readonly ToolCallOutcome[] = [
  "allow",
  "ask",
  "refuse",
];

export function isToolCallOutcome(value: unknown): value is ToolCallOutcome {
  return (
    typeof value === "string" &&
    (TOOL_CALL_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The outcome for a tool nobody has set: a tool that changes things asks, a tool that only reads runs.
 *
 * "Changes things" is the classifier's `write`, which fails closed — anything not positively known to
 * be a read is a write — so an action the vendor never described is asked about rather than run.
 * That is the default the owner asked for: actions that send, pay, delete or change records wait for
 * a person unless an administrator has said this one need not.
 *
 * ONLY WHERE SOMEBODY CAN BE ASKED. A deployment wired without an inbox (a test harness, a script)
 * has nobody to put the question to, and holding every write there would be refusing every write
 * under another name. An administrator's explicit "ask" still holds there, and is refused, because
 * that is a rule somebody wrote rather than a default.
 */
export function toolCallOutcome(input: {
  set: ToolCallOutcome | null;
  effect: "read" | "write";
  canAsk: boolean;
}): ToolCallOutcome {
  if (input.set) return input.set;
  return input.effect === "write" && input.canAsk ? "ask" : "allow";
}

/**
 * What leads a tool answer that says the call is waiting for a person.
 *
 * A marker for the same reason `REFUSAL_MARKER` is one: a transcript can draw a held call as waiting
 * rather than as a result, without reading the wording.
 */
export const HELD_MARKER = "Waiting for approval.";

/** A tool call the gateway held, as the approval inbox is asked to keep it. */
export type HeldToolCall = {
  /** The person whose run this is, who decides. */
  ownerUserId: string;
  botId: string;
  /** `<serverId>/<toolName>`. */
  ref: string;
  server: string;
  serverTitle: string;
  tool: string;
  /** Exactly what will be sent if it is approved, and what the person is shown. */
  args: Record<string, unknown>;
  /** The vendor's version of the action at the time it was asked, so a changed action is not run. */
  version: string | null;
  effect: "read" | "write";
  /** Why it was held: the tool is set to ask, or a boundary rule asks. */
  because: { kind: "tool" } | { kind: "rule"; rule: string | null };
  threadId?: string;
  runId?: string;
  initiator?: AuditInitiator;
};

/** An approved call, as the row the person approved says it, and nothing a caller supplies. */
export type ApprovedToolCall = {
  ownerUserId: string;
  botId: string;
  ref: string;
  args: Record<string, unknown>;
  version: string | null;
};

/**
 * The inbox, as the plugin store sees it.
 *
 * A seam rather than the approval store itself, because the approval store's executor calls back
 * into the plugin store to carry the call out once it is approved, and the two cannot each be built
 * first.
 */
export type ToolCallApprovals = {
  /**
   * Put the call in front of the person. Answers with the request and the sentence the employee is
   * given. Throws a refusal the employee can relay (the person already has too many waiting).
   */
  hold(call: HeldToolCall): Promise<{ id: string; message: string }>;
  /** The approved call behind this id, or null when there is none — not approved, or not a call. */
  approved(id: string): Promise<ApprovedToolCall | null>;
};
