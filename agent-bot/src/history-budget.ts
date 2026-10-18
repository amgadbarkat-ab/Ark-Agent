/**
 * How much of a conversation the model is shown on each turn.
 *
 * AG-UI carries the whole conversation on every run, and until this existed this service passed all of
 * it to the model, so the cost of a turn grew with the length of the conversation: the fortieth message
 * paid for the other thirty-nine, every tool result in them included. Tool results are the worst of it.
 * A file read or a page fetched twenty turns ago is thousands of tokens the model will never look at
 * again, and it is billed again on every turn after.
 *
 * Three limits, applied in this order, and none of them touches the standing role or any other system
 * message, because that is who the digital employee is:
 *
 *  1. Only the most recent turns are shown. A turn begins at a person's message, so a cut never lands
 *     between a tool call and its result, which a provider rejects outright.
 *  2. A tool result from an earlier turn is shortened to its opening. The turn being answered right now
 *     keeps every result in full, because the model is still using them.
 *  3. If what is left is still over the character budget, the oldest turn goes too, until one is left.
 *
 * What was left out is said, once, in a system note, so the model tells the person it cannot see
 * something rather than inventing what was in it. That is the whole cost of the saving and it is
 * stated rather than hidden: a digital employee that has been talking for a day remembers the last few
 * turns, not the first.
 */
import type { RunAgentInput } from "@ag-ui/core";

type Message = RunAgentInput["messages"][number];

export type HistoryBudget = {
  /** Person's messages kept, counting from the latest. Zero keeps everything. */
  turns: number;
  /** A budget for what is shown, in characters (about four to a token). Zero keeps everything. */
  characters: number;
  /** The longest an earlier tool result may be. Zero leaves them whole. */
  toolResultCharacters: number;
};

export const DEFAULT_BUDGET: HistoryBudget = {
  turns: 12,
  characters: 60_000,
  toolResultCharacters: 2_000,
};

function whole(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The limits a deployment chose, falling back to the defaults for anything unset or unreadable. */
export function budgetFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): HistoryBudget {
  return {
    turns: whole(environment.BOT_HISTORY_TURNS, DEFAULT_BUDGET.turns),
    characters: whole(
      environment.BOT_HISTORY_CHARACTERS,
      DEFAULT_BUDGET.characters,
    ),
    toolResultCharacters: whole(
      environment.BOT_TOOL_RESULT_CHARACTERS,
      DEFAULT_BUDGET.toolResultCharacters,
    ),
  };
}

function sizeOf(message: Message): number {
  const content = (message as { content?: unknown }).content;
  const text =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  const calls = (message as { toolCalls?: unknown }).toolCalls;
  return text.length + (calls ? JSON.stringify(calls).length : 0);
}

function shortened(message: Message, limit: number): Message {
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.length <= limit) return message;
  return {
    ...message,
    content: `${content.slice(0, limit)}\n[${content.length - limit} more characters of this result were left out to keep the conversation short]`,
  } as Message;
}

export type EconomisedHistory = {
  messages: Message[];
  /** How many messages of the conversation were left out entirely. */
  omitted: number;
};

export function economise(
  messages: Message[],
  budget: HistoryBudget,
): EconomisedHistory {
  const isStanding = (message: Message) =>
    message.role === "system" || message.role === "developer";

  // Where each turn begins. Everything before the first one (there is rarely anything) rides along
  // with it, because it has nothing to anchor a cut to.
  const starts = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length === 0) return { messages, omitted: 0 };

  let firstKept =
    budget.turns > 0 ? Math.max(0, starts.length - budget.turns) : 0;
  const lastStart = starts[starts.length - 1] ?? 0;

  const assemble = (from: number): Message[] => {
    const cut = from === 0 ? 0 : (starts[from] ?? 0);
    return messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => index >= cut || isStanding(message))
      .map(({ message, index }) =>
        budget.toolResultCharacters > 0 &&
        message.role === "tool" &&
        index < lastStart
          ? shortened(message, budget.toolResultCharacters)
          : message,
      );
  };

  let kept = assemble(firstKept);
  if (budget.characters > 0) {
    const total = (list: Message[]) =>
      list.reduce((sum, message) => sum + sizeOf(message), 0);
    while (total(kept) > budget.characters && firstKept < starts.length - 1) {
      firstKept += 1;
      kept = assemble(firstKept);
    }
  }

  const omitted = messages.length - kept.length;
  if (omitted <= 0) return { messages: kept, omitted: 0 };

  const note: Message = {
    id: "history-omitted",
    role: "system",
    content: `The earlier part of this conversation (${omitted} messages) is not shown to you, to keep replies quick and inexpensive. If the person refers to something you cannot see, say so and ask them to say it again. Do not guess what it was.`,
  } as Message;
  // After the standing messages and before the first turn that is shown.
  const firstTurn = kept.findIndex((message) => !isStanding(message));
  const at = firstTurn === -1 ? kept.length : firstTurn;
  return {
    messages: [...kept.slice(0, at), note, ...kept.slice(at)],
    omitted,
  };
}
