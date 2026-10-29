import type { AuditInitiator } from "../audit";
import type { HandoffWork } from "../agents/handoff-runner";
import { HANDOFF_KIND } from "../agents/handoff";
import type {
  ActionActor,
  ActionRun,
  ApprovedComputerAction,
  ComputerActionApprovals,
  ComputerActionName,
  ComputerGateway,
  HeldComputerAction,
} from "../computer/gateway";
import type {
  ApprovedToolCall,
  HeldToolCall,
  ToolCallApprovals,
} from "../plugins/call-outcome";
import { PluginRefusedError } from "../plugins/store";
import { vendorAnswer } from "../plugins/tools";
import type { WorkQueue } from "../work/queue";
import {
  type ApprovalAfterDecision,
  type ApprovalExecutor,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalStore,
} from "./store";

/**
 * Calls and actions a gateway held for a person, and what happens when the person decides.
 *
 * THE RUN DOES NOT WAIT; IT ENDS AND IS PICKED UP AGAIN. A person may decide in a minute or on
 * Monday, and a run held open that long is a socket, a lock on the conversation and a model turn
 * nobody can finish. So the gateway answers the employee at once — "this is waiting for your
 * approval", which it tells the person — and the run ends normally. When the person decides, the
 * outcome is delivered into the same conversation through the hand-off desk's queue, as a hop that
 * resumes the employee (`HandoffWork.resume`): durable, retried, run by whichever replica gets to it,
 * and built exactly as a person's own run builds the employee, so it works the same for a built-in
 * employee and for one at an endpoint (every hired employee on the desktop is `remote_ag_ui` at the
 * bundled agent-langgraph).
 *
 * THE CALL RUNS ON APPROVAL, HERE, NOT IN THE RESUMED RUN. The resumed employee is handed the
 * result; it is not asked to make the call again, because a call it made again would be a call the
 * person never saw — regenerated arguments are exactly what approval exists to rule out.
 */

/** A tool call the plugin gateway held. */
export const TOOL_CALL_KIND = "tool.call";
/** A browser or computer action the computer gateway held. */
export const COMPUTER_ACTION_KIND = "computer.action";
/**
 * An approval card a digital employee raised in a conversation (`askApproval`).
 *
 * The card itself is what resumes that run: its answer is the tool result. The row exists so the
 * card is listed beside everything else that needs the person, and so a decision taken from the
 * list reaches the card (which watches its row) and a decision taken on the card clears the list.
 */
export const CHAT_CARD_KIND = "chat.card";

/** How much of a tool's answer one resumed run carries back. Same reasoning as the relay's cap. */
const RESULT_LIMIT = 12_000;

type ToolCallPayload = {
  ref: string;
  server: string;
  serverTitle: string;
  tool: string;
  args: Record<string, unknown>;
  version: string | null;
  effect: "read" | "write";
  because: HeldToolCall["because"];
  initiator?: AuditInitiator;
};

type ComputerActionPayload = Omit<
  HeldComputerAction,
  "ownerUserId" | "botId" | "threadId" | "runId"
>;

/** The card's own words, as the employee wrote them. Shown, never executed. */
type ChatCardPayload = {
  title: string;
  summary: string;
  details: { label: string; value: string }[];
  toolCallId: string;
  channelId?: string;
};

/** A refusal from the inbox (too many waiting) as the gateway's own refusal, so it is relayed. */
async function asking<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApprovalRefusedError) {
      throw new PluginRefusedError(error.message, null);
    }
    throw error;
  }
}

/** What the employee is told when its call is held. */
function heldMessage(what: string, threadId: string | undefined): string {
  return [
    `${what} has NOT been done yet. It is waiting for the person to approve it in Requests.`,
    "Tell them plainly that it is waiting for their approval and what it will do once approved.",
    "Do not try to do it another way, and do not say it is done.",
    threadId
      ? "When they decide, the outcome comes back into this conversation and you carry on from there."
      : "When they decide it is carried out or dropped; this conversation is not told, so ask them to check Requests.",
  ].join(" ");
}

export function toolCallApprovals(store: ApprovalStore): ToolCallApprovals {
  return {
    async hold(call) {
      const what = `${call.tool} on ${call.serverTitle}`;
      const payload: ToolCallPayload = {
        ref: call.ref,
        server: call.server,
        serverTitle: call.serverTitle,
        tool: call.tool,
        args: call.args,
        version: call.version,
        effect: call.effect,
        because: call.because,
        ...(call.initiator ? { initiator: call.initiator } : {}),
      };
      const record = await asking(() =>
        store.request({
          ownerUserId: call.ownerUserId,
          requestedByAgentId: call.botId,
          kind: TOOL_CALL_KIND,
          targetId: call.ref,
          // Written here from the call, never by the model: the arguments are shown beside it.
          summary: `Call ${what}${call.effect === "write" ? ", which changes something there" : ""}.`,
          payload,
          ...(call.threadId ? { threadId: call.threadId } : {}),
          ...(call.runId ? { runId: call.runId } : {}),
        }),
      );
      return {
        id: record.id,
        message: heldMessage(`Your call to ${what}`, call.threadId),
      };
    },

    async approved(id) {
      const record = await store.find(id);
      if (
        !record ||
        record.kind !== TOOL_CALL_KIND ||
        record.status !== "approved"
      ) {
        return null;
      }
      const payload = record.payload as Partial<ToolCallPayload>;
      if (typeof payload.ref !== "string" || !isObject(payload.args)) {
        return null;
      }
      return {
        ownerUserId: record.ownerUserId,
        botId: record.requestedByAgentId,
        ref: payload.ref,
        args: payload.args,
        version: payload.version ?? null,
      } satisfies ApprovedToolCall;
    },
  };
}

/** Running an approved tool call: the plugin gateway, from the row, and nothing else. */
export function toolCallExecutor(
  callTool: (input: {
    ref: string;
    args: Record<string, unknown>;
    botId: string;
    actorId: string;
    initiator?: AuditInitiator;
    approvalId: string;
  }) => Promise<{ text: string; isError: boolean; held?: unknown }>,
): ApprovalExecutor {
  return async (approval) => {
    const payload = approval.payload as Partial<ToolCallPayload>;
    if (typeof payload.ref !== "string") {
      throw new Error("The request does not say which tool to call.");
    }
    const result = await callTool({
      ref: payload.ref,
      // Ignored by the gateway on an approved call, which reads the row; passed empty so nothing
      // here could be mistaken for the arguments that run.
      args: {},
      botId: approval.requestedByAgentId,
      actorId: approval.ownerUserId,
      ...(payload.initiator ? { initiator: payload.initiator } : {}),
      approvalId: approval.id,
    });
    if (result.held) {
      throw new Error("The call was held again instead of being made.");
    }
    return vendorAnswer(result);
  };
}

export function computerActionApprovals(
  store: ApprovalStore,
): ComputerActionApprovals {
  return {
    async hold(action) {
      const what = describeAction(action);
      const { ownerUserId, botId, threadId, runId, reason, ...rest } = action;
      const payload: ComputerActionPayload = { ...rest, reason };
      const record = await asking(() =>
        store.request({
          ownerUserId,
          requestedByAgentId: botId,
          kind: COMPUTER_ACTION_KIND,
          targetId: action.action,
          summary: `${what[0]?.toUpperCase()}${what.slice(1)}.`,
          payload,
          ...(threadId ? { threadId } : {}),
          ...(runId ? { runId } : {}),
        }),
      );
      return {
        id: record.id,
        message: heldMessage(`This action (${what})`, threadId),
      };
    },

    async approved(id) {
      const record = await store.find(id);
      if (
        !record ||
        record.kind !== COMPUTER_ACTION_KIND ||
        record.status !== "approved"
      ) {
        return null;
      }
      const payload = record.payload as Partial<ComputerActionPayload>;
      if (typeof payload.action !== "string") return null;
      return {
        ownerUserId: record.ownerUserId,
        botId: record.requestedByAgentId,
        action: payload.action,
        input: payload.input,
        ...(payload.ref ? { ref: payload.ref } : {}),
        ...(payload.snapshotId !== undefined
          ? { snapshotId: payload.snapshotId }
          : {}),
        ...(payload.session ? { session: payload.session } : {}),
        element: payload.element ?? null,
        pageUrl: payload.pageUrl ?? "",
        ...(payload.key ? { key: payload.key } : {}),
        ...(payload.command ? { command: payload.command } : {}),
        ...(payload.filePath ? { filePath: payload.filePath } : {}),
        rule: payload.rule ?? null,
      } satisfies ApprovedComputerAction;
    },
  };
}

/** Carrying out an approved action: the computer gateway, with the approved input, checked again. */
export function computerActionExecutor(
  gateway: () => ComputerGateway | undefined,
): ApprovalExecutor {
  return async (approval) => {
    const computer = gateway();
    if (!computer) {
      throw new Error("This deployment has no computer to carry it out on.");
    }
    const payload = approval.payload as Partial<ComputerActionPayload>;
    const actor: ActionActor = {
      id: approval.ownerUserId,
      userId: approval.ownerUserId,
    };
    const run: ActionRun = { approvalId: approval.id };
    const bot = approval.requestedByAgentId;
    const input = payload.input as never;
    const result = await replay(
      computer,
      payload.action,
      bot,
      actor,
      input,
      run,
    );
    return `Done. ${describeResult(result)}`;
  };
}

function replay(
  computer: ComputerGateway,
  action: ComputerActionName | undefined,
  bot: string,
  actor: ActionActor,
  input: never,
  run: ActionRun,
): Promise<unknown> {
  switch (action) {
    case "computer_navigate":
      return computer.navigate(
        bot,
        actor,
        String((input as { url?: unknown }).url ?? ""),
        run,
      );
    case "computer_click":
      return computer.click(bot, actor, input, undefined, run);
    case "computer_type":
      return computer.type(bot, actor, input, undefined, run);
    case "computer_key":
      return computer.key(bot, actor, input, undefined, run);
    case "computer_scroll":
      return computer.scroll(bot, actor, input, run);
    case "computer_read_file":
      return computer.readFile(bot, actor, input, run);
    case "computer_list_files":
      return computer.listFiles(bot, actor, input, run);
    case "computer_run_command":
      return computer.runCommand(bot, actor, input, undefined, run);
    case "computer_write_file":
      return computer.writeFile(bot, actor, input, run);
    default:
      return Promise.reject(new Error("The request does not say what to do."));
  }
}

/** A result in a line, without the typed text or a file's contents being repeated anywhere new. */
function describeResult(result: unknown): string {
  if (!isObject(result)) return "";
  const parts: string[] = [];
  if (typeof result.url === "string")
    parts.push(`The page is now ${result.url}.`);
  if (typeof result.exitCode === "number") {
    parts.push(`The command exited with ${result.exitCode}.`);
    if (typeof result.stdout === "string" && result.stdout.trim()) {
      parts.push(`Output:\n${result.stdout.slice(0, 4000)}`);
    }
  }
  if (typeof result.text === "string" && typeof result.path === "string") {
    parts.push(`Contents of ${result.path}:\n${result.text.slice(0, 4000)}`);
  }
  return parts.join(" ");
}

/** The action in a phrase a person can approve: what, on what, where. */
export function describeAction(
  action: Pick<
    HeldComputerAction,
    "action" | "element" | "pageUrl" | "key" | "command" | "filePath" | "input"
  >,
): string {
  const on = action.element
    ? `“${action.element.name || action.element.role}”`
    : "the page";
  const host = hostOf(action.pageUrl);
  const where = host ? ` on ${host}` : "";
  switch (action.action) {
    case "computer_click":
      return `click ${on}${where}`;
    case "computer_type":
      return `type into ${on}${where}${action.key ? " and press Enter" : ""}`;
    case "computer_key":
      return `press ${action.key ?? "a key"}${action.element ? ` on ${on}` : ""}${where}`;
    case "computer_navigate": {
      const url = isObject(action.input) ? String(action.input.url ?? "") : "";
      return `open ${url || "a page"}`;
    }
    case "computer_run_command":
      return `run the command \`${action.command ?? ""}\``;
    case "computer_write_file":
      return `write the file ${action.filePath ?? ""}`;
    case "computer_read_file":
      return `read the file ${action.filePath ?? ""}`;
    case "computer_list_files":
      return `list the files in ${action.filePath ?? "the workspace"}`;
    default:
      return `scroll the page${where}`;
  }
}

/**
 * Put the outcome back into the conversation the call was held in, so the employee carries on.
 *
 * A backwards hop on the hand-off desk's queue, keyed on the request so a decision is delivered once
 * however many times this runs. No conversation, nothing to deliver: the decision is still recorded,
 * and the request said so to the employee when it was made.
 */
export function resumeInConversation(
  queue: Pick<WorkQueue, "offer">,
): ApprovalAfterDecision {
  return async (approval, outcome) => {
    if (!approval.threadId) return;
    const payload = approval.payload as { initiator?: AuditInitiator };
    const work: HandoffWork = {
      fromBotId: approval.requestedByAgentId,
      toBotId: approval.requestedByAgentId,
      actorId: approval.ownerUserId,
      threadId: approval.threadId,
      runId: approval.runId ?? approval.id,
      depth: 0,
      ...(payload.initiator ? { initiator: payload.initiator } : {}),
      answerIn: approval.threadId,
      resume: true,
      task: resumeTask(approval, outcome.text),
    };
    await queue.offer({
      kind: HANDOFF_KIND,
      key: `approval:${approval.id}`,
      payload: work as unknown as Record<string, unknown>,
    });
  };
}

/** What the resumed employee is told, by outcome. Exported for the test that pins the wording. */
export function resumeTask(
  approval: Pick<
    ApprovalRecord,
    "kind" | "status" | "result" | "payload" | "summary"
  >,
  text: string | null,
): string {
  const what =
    approval.kind === TOOL_CALL_KIND
      ? (() => {
          const payload = approval.payload as Partial<ToolCallPayload>;
          return `your call to ${payload.tool ?? "a tool"} on ${payload.serverTitle ?? "a connector"}`;
        })()
      : `the action you asked for (${approval.summary.replace(/\.$/, "")})`;
  if (approval.status === "rejected") {
    return `The person declined ${what}. It was not done. Tell them plainly that it was not done, and do not try to do it another way unless they ask you to.`;
  }
  if (approval.status === "failed") {
    return `The person approved ${what}, but it could not be carried out: ${approval.result ?? "it failed"}. Tell them plainly that it did not happen, and why.`;
  }
  const answer = (text ?? approval.result ?? "").slice(0, RESULT_LIMIT);
  return [
    `The person approved ${what}, and it was carried out exactly as they were shown.`,
    approval.kind === TOOL_CALL_KIND ? "The tool answered:" : "What came back:",
    "",
    answer || "(nothing)",
    "",
    "Carry on from where you stopped: tell the person the outcome, and continue the work if there is more to do.",
  ].join("\n");
}

/** A chat card answered in the list: nothing to run, the card resumes its own run. */
export const chatCardExecutor: ApprovalExecutor = async () =>
  "Approved. The conversation carries on from the card.";

/**
 * What the person reads beside a request, in rows of label and value.
 *
 * For a held call these are its exact arguments: what the person approves is what runs, so they are
 * shown as they will be sent, strings as written and anything else as JSON.
 */
export function approvalDetails(
  record: Pick<ApprovalRecord, "kind" | "payload">,
): { label: string; value: string }[] {
  const payload = (isObject(record.payload) ? record.payload : {}) as Record<
    string,
    unknown
  >;
  if (record.kind === TOOL_CALL_KIND) {
    const args = isObject(payload.args) ? payload.args : {};
    const rows = [
      { label: "Tool", value: `${payload.tool} on ${payload.serverTitle}` },
      ...Object.entries(args).map(([label, value]) => ({
        label,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
    ];
    return rows;
  }
  if (record.kind === COMPUTER_ACTION_KIND) {
    const input = isObject(payload.input) ? payload.input : {};
    const element = isObject(payload.element) ? payload.element : null;
    const rows: { label: string; value: string }[] = [];
    if (typeof payload.pageUrl === "string" && payload.pageUrl) {
      rows.push({ label: "Page", value: payload.pageUrl });
    }
    if (element) {
      rows.push({
        label: "Element",
        value: `${element.role ?? ""} “${element.name ?? ""}”`.trim(),
      });
    }
    if (typeof input.url === "string")
      rows.push({ label: "Address", value: input.url });
    // Shown, because the person is approving it; it is their employee typing it on their behalf.
    if (typeof input.text === "string")
      rows.push({ label: "Text", value: input.text });
    if (typeof payload.key === "string")
      rows.push({ label: "Key", value: payload.key });
    if (typeof payload.command === "string") {
      rows.push({ label: "Command", value: payload.command });
    }
    if (typeof payload.filePath === "string") {
      rows.push({ label: "File", value: payload.filePath });
    }
    if (typeof payload.rule === "string") {
      rows.push({ label: "Held by the rule", value: payload.rule });
    }
    return rows;
  }
  if (record.kind === CHAT_CARD_KIND && Array.isArray(payload.details)) {
    return (payload.details as unknown[])
      .filter(isObject)
      .map((row) => ({
        label: String(row.label ?? ""),
        value: String(row.value ?? ""),
      }));
  }
  return [];
}

export type { ChatCardPayload };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
