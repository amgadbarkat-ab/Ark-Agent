/**
 * The conversation AG-UI carries, as LangChain's message classes.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at module
 * scope, so importing it to reach one pure function binds a port. `agent-computer/src/control.ts`
 * was split out for the same reason, to keep state-machine tests away from a browser.
 */
import type { RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { COMPUTER_GUIDANCE, NO_ANSWER_CAME } from "../../shared/bot-prompt";
import { leftOutNote } from "../../shared/prompt-budget";
import { userContent } from "../../shared/user-content";

/*
 * Re-exported so this module's own tests and callers keep reading it from here, while the wording
 * itself lives in `shared` where the other Bot can reach it. Both have to say the same thing.
 */
export { NO_ANSWER_CAME };

/**
 * The providers that take one system prompt, and take it first.
 *
 * Anthropic's Messages API has the system prompt as a field of the request rather than as a turn,
 * and Gemini has it as `systemInstruction`, so neither integration has anywhere to put a second one:
 * `@langchain/anthropic` throws "System messages are only permitted as the first passed message."
 * and `@langchain/google-genai` throws "System message should be the first one", both before any
 * request is made. OpenAI takes a system turn anywhere in a conversation.
 */
const ONE_SYSTEM_PROMPT = new Set(["anthropic", "google"]);

/**
 * The system turns at the head of a run, and the rest of the conversation after them.
 *
 * The server puts a coworker's standing role there (who it is, its title, its instructions, its
 * team) and then what it holds. Everything after the first turn that is not a system one is the
 * conversation, and a system turn found there is a skill somebody picked for the message beside it.
 */
function splitLeadingSystemTurns(messages: RunAgentInput["messages"]): {
  standing: string[];
  rest: RunAgentInput["messages"];
} {
  const standing: string[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message?.role !== "system" && message?.role !== "developer") break;
    const text = String(message.content ?? "").trim();
    if (text) standing.push(text);
    index += 1;
  }
  return { standing, rest: messages.slice(index) };
}

/** Translate the conversation AG-UI carries into LangChain's message classes. */
export function toLangChainMessages(
  input: RunAgentInput,
  provider = "openai",
  /** Tools this run was not offered, so the model is told rather than left to guess. */
  leftOut: string[] = [],
): BaseMessage[] {
  const { standing, rest } = splitLeadingSystemTurns(input.messages ?? []);
  const messages: BaseMessage[] = [
    /*
     * ONE SYSTEM MESSAGE, AND THE EMPLOYEE'S OWN ROLE IN IT FIRST.
     *
     * This used to be three or four: the computer guidance, then the caller's context (the whole
     * A2UI catalog among it), and the role only after those as the head of the conversation. A model
     * on a free OpenRouter plan answered "I'm Command, an AI assistant", described A2UI when asked
     * what it could do, and said it saw no marketing agent, with the role it had been sent sitting
     * third in a list of system messages. Some OpenAI-compatible providers read only the first of
     * several system messages, and a small model that reads them all gives most weight to what
     * comes first, which was a page about the browser.
     *
     * Who the employee is goes first, then the computer, then the catalogs that describe the screen.
     */
    new SystemMessage(
      [
        ...standing,
        COMPUTER_GUIDANCE,
        // AG-UI carries application context separately from conversation history. CopilotKit puts
        // the A2UI catalog and tool instructions here; dropping it leaves the model guessing the
        // component schema and can strand the renderer on an invalid, never-painted surface.
        ...(input.context ?? []).map(
          ({ description, value }) => `${description}\n${value}`,
        ),
        ...(leftOut.length > 0 ? [leftOutNote(leftOut)] : []),
      ].join("\n\n"),
    ),
  ];

  /*
   * Which calls in this history were ever answered.
   *
   * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
   * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot
   * asks for the wheel to get past a sign-in and the person decides they do not need it after all —
   * no answer is ever carried, and the call stays in the history with nothing following it.
   *
   * OpenAI rejects that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
   * followed by tool messages responding to each 'tool_call_id'". So the conversation was not merely
   * stuck on that request, it was finished. Every later message failed the same way, and the only
   * escape was starting a new one, which loses it.
   *
   * Collected up front because an answer arrives as a later message than the call it answers.
   */
  const answered = new Set(
    rest
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId?: string }).toolCallId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const message of rest) {
    if (message.role === "user") {
      messages.push(
        new HumanMessage({ content: userContent(message.content) }),
      );
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push(new SystemMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "tool") {
      // Tool results are appended so the model can continue from the completed call.
      messages.push(
        new ToolMessage({
          tool_call_id: message.toolCallId,
          content: String(message.content ?? ""),
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      messages.push(
        new AIMessage({
          content: message.content ?? "",
          tool_calls:
            message.toolCalls?.map((call) => ({
              id: call.id,
              name: callDetails(call).name,
              // LangChain wants parsed arguments where AG-UI carries the raw string. A call whose
              // arguments did not parse is passed as empty rather than dropped: the model needs to
              // see that it made the call, or it makes it again.
              args: parseArguments(callDetails(call).arguments),
            })) ?? [],
        }),
      );

      /*
       * Close any of its calls that nothing ever answered, immediately after it.
       *
       * Position is not cosmetic: a tool result has to follow the assistant message that made the
       * call, so these go here rather than being appended at the end. A call answered later in the
       * history is left alone and its real answer arrives in its own turn.
       */
      for (const call of message.toolCalls ?? []) {
        if (call.id && !answered.has(call.id)) {
          messages.push(
            new ToolMessage({
              tool_call_id: call.id,
              content: NO_ANSWER_CAME,
              name: callDetails(call).name,
            }),
          );
        }
      }
    }
  }

  /*
   * A run that carries no human turn is answered by OpenAI and refused by the strict providers.
   *
   * OpenAI tolerates a history that opens on an assistant or tool message. Anthropic and the strict
   * OpenAI-compatible providers (z.ai GLM among them) require the first non-system message to be a
   * human one, and will not answer a history that is only deltas: an assistant turn and its tool
   * results with nothing a person said to respond to. A follow-up run continuing after a tool result
   * is exactly that shape, so on those providers it came back empty and the run ended in silence.
   *
   * A neutral continuation turn gives them one to answer. It is appended only when the history holds
   * no human turn at all, so a normal conversation is untouched, and OpenAI — which already answered
   * the same history — sees no change beyond one trailing line asking it to continue.
   */
  const hasHumanTurn = messages.some(
    (message): message is HumanMessage => message instanceof HumanMessage,
  );
  if (!hasHumanTurn) {
    messages.push(new HumanMessage(CONTINUE_TURN));
  }

  /*
   * A skill somebody picks is a second system message, and these providers refuse a second.
   *
   * The head of the run is already one message (see above). A skill arrives as a system turn ahead
   * of the message it was picked for, and a Bot set to `BOT_PROVIDER=anthropic` or `google` answered
   * nothing at all when it met one: the integration refused before the model was asked.
   *
   * Folded into the one at the top, in the order given, and only for those providers. On OpenAI a
   * skill's instruction stays beside the message it was picked for.
   */
  return ONE_SYSTEM_PROMPT.has(provider)
    ? withOneSystemPrompt(messages)
    : messages;
}

/** The continuation a strict provider needs when a run carries only deltas. See toLangChainMessages. */
const CONTINUE_TURN = "Continue from where the conversation above left off.";

/** Every system message's text as one system message at the top, and the rest as they were. */
function withOneSystemPrompt(messages: BaseMessage[]): BaseMessage[] {
  const system = messages.filter((message) => message instanceof SystemMessage);
  return [
    new SystemMessage(
      system.map((message) => String(message.content)).join("\n\n"),
    ),
    ...messages.filter((message) => !(message instanceof SystemMessage)),
  ];
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A tool call's name and arguments, in whichever dialect it arrived in.
 *
 * TWO SPELLINGS, ONE CALL. AG-UI describes `{id, type: "function", function: {name, arguments}}` and
 * the history store writes `{id, name, args}`. Read back from a thread, every call arrives in the
 * second, so `call.function.name` here did not merely degrade: it threw, and took the run with it.
 */
function callDetails(call: {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
  args?: unknown;
}): { name: string; arguments: string } {
  const name = call.function?.name ?? call.name;
  const args = call.function?.arguments ?? call.args;
  return {
    name: typeof name === "string" && name ? name : "tool",
    arguments:
      typeof args === "string"
        ? args
        : args === undefined || args === null
          ? "{}"
          : JSON.stringify(args),
  };
}
