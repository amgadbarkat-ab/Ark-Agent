/**
 * The conversation AG-UI carries, as the shape the model provider expects.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at module
 * scope, so importing it to reach one pure function binds a port. `agent-langgraph/src/history.ts`
 * and `agent-computer/src/control.ts` were split out for the same reason.
 */
import type { RunAgentInput } from "@ag-ui/core";
import type OpenAI from "openai";
import { COMPUTER_GUIDANCE, NO_ANSWER_CAME } from "../../shared/bot-prompt";
import { leftOutNote } from "../../shared/prompt-budget";
import { userContent } from "../../shared/user-content";
import {
  budgetFromEnvironment,
  economise,
  type HistoryBudget,
} from "./history-budget";

export { NO_ANSWER_CAME };

/**
 * Translate the conversation AG-UI carries into the shape the model provider expects.
 *
 * Not all of it: `economise` keeps the standing role and the recent turns and shortens old tool results,
 * so the price of a turn stops growing with the length of the conversation. See `history-budget.ts`.
 */
export function toProviderMessages(
  input: RunAgentInput,
  budget: HistoryBudget = budgetFromEnvironment(),
  /** Tools this run was not offered, so the model is told rather than left to guess. */
  leftOut: string[] = [],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const economised = economise(input.messages, budget).messages;
  /*
   * The system turns at the head of the run: the employee's standing role (who it is, its title, its
   * instructions, its team) and what it holds. Everything after the first turn that is not a system
   * one is the conversation, and a system turn found there is a skill picked for the message beside it.
   */
  const standing: string[] = [];
  let lead = 0;
  while (
    lead < economised.length &&
    (economised[lead]?.role === "system" ||
      economised[lead]?.role === "developer")
  ) {
    const text = String(economised[lead]?.content ?? "").trim();
    if (text) standing.push(text);
    lead += 1;
  }
  const history = economised.slice(lead);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    /*
     * ONE SYSTEM MESSAGE, AND THE EMPLOYEE'S OWN ROLE IN IT FIRST.
     *
     * Some OpenAI-compatible providers read only the first of several system messages, and a small
     * model that reads them all gives most weight to what comes first. This used to open with the
     * computer guidance and the whole A2UI catalog and send the role third, so a model on a free
     * plan answered as the provider's own assistant and described the catalog when asked what it
     * could do. Who the employee is goes first, then the computer, then the screen's catalogs.
     */
    {
      role: "system",
      content: [
        ...standing,
        COMPUTER_GUIDANCE,
        // AG-UI application context is separate from history. The A2UI catalog and tool
        // instructions arrive here; omitting them leaves the model guessing component names and
        // action schemas.
        ...(input.context ?? []).map(
          ({ description, value }) => `${description}\n${value}`,
        ),
        ...(leftOut.length > 0 ? [leftOutNote(leftOut)] : []),
      ].join("\n\n"),
    },
  ];

  /*
   * Which calls in this history were ever answered.
   *
   * Collected up front because an answer arrives as a later message than the call it answers. See
   * `NO_ANSWER_CAME` for what happens to a conversation carrying a call nothing ever answered.
   */
  const answered = new Set(
    history
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId?: string }).toolCallId)
      .filter((id): id is string => Boolean(id)),
  );

  /*
   * Tool results, by the call they answer.
   *
   * The history is not guaranteed to arrive with a result after the call it belongs to. Read back
   * from the durable thread store it arrives the other way round, result first, which is a payload
   * no provider accepts: a tool message with no preceding call, and then a call with nothing
   * following it. The model answers that with silence rather than an error, which is the worst of
   * both, so the pairing is rebuilt here instead of trusted.
   */
  const resultsByCall = new Map<string, string>();
  for (const message of history) {
    if (message.role !== "tool") continue;
    const id = (message as { toolCallId?: string }).toolCallId;
    if (id) resultsByCall.set(id, String(message.content ?? ""));
  }

  for (const message of history) {
    // Placed with the call they answer, below, rather than wherever they arrived.
    if (message.role === "tool") continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content) });
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push({ role: "system", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: callDetails(call),
      }));
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });

      /*
       * Close any of its calls that nothing ever answered, immediately after it.
       *
       * Position is not cosmetic: a tool result has to follow the assistant message that made the
       * call, so these go here rather than being appended at the end. A call answered later in the
       * history is left alone and its real answer arrives in its own turn.
       */
      /*
       * Every call this message made, answered, immediately after it.
       *
       * The real result where there is one, wherever it arrived in the input, and `NO_ANSWER_CAME`
       * where there is not. Both cases are the same requirement: a call must be followed by its
       * result, and the provider rejects the message outright otherwise.
       */
      for (const call of message.toolCalls ?? []) {
        if (!call.id) continue;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: answered.has(call.id)
            ? (resultsByCall.get(call.id) ?? "")
            : NO_ANSWER_CAME,
        });
      }
    }
  }

  return messages;
}

/**
 * A tool call's name and arguments, in whichever dialect it arrived in.
 *
 * TWO SPELLINGS, ONE CALL. AG-UI describes `{id, type: "function", function: {name, arguments}}` and
 * the history store writes `{id, name, args}`. Read back from a thread, every call arrives in the
 * second, so code reaching straight for `call.function` finds nothing there.
 *
 * That was diagnosed here as "the name is not always present" and papered over with a default, which
 * turned every restored call into a tool named `tool` with no arguments. The model is then shown a
 * call it cannot recognise as the one it made, so it makes it again: the exact repetition the
 * fallback was written to prevent.
 */
function callDetails(call: {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
  args?: unknown;
}): { name: string; arguments: string } {
  const name = call.function?.name ?? call.name;
  const args = call.function?.arguments ?? call.args;
  return {
    // Still defaulted, because a call with no name at all is rejected outright by the provider and
    // showing the model something is better than losing the turn. It is now the last resort it was
    // meant to be rather than the ordinary path.
    name: typeof name === "string" && name ? name : "tool",
    arguments:
      typeof args === "string"
        ? args
        : args === undefined || args === null
          ? "{}"
          : JSON.stringify(args),
  };
}
