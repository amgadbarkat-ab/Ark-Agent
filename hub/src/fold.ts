/**
 * A conversation's messages, rebuilt from its event log.
 *
 * The event log is the source of truth. Messages are a view of it, derived on read, so there is
 * nothing to keep in step and a replay can never disagree with the history.
 */

export interface ThreadMessage {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  toolCallId?: string;
}

type AgUiEvent = { type?: string } & Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function foldMessages(events: Iterable<AgUiEvent>): ThreadMessage[] {
  const order: string[] = [];
  const byId = new Map<string, ThreadMessage>();
  /** Which message each in-flight tool call belongs to. */
  const callOwner = new Map<string, string>();

  const put = (message: ThreadMessage) => {
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, message);
    return message;
  };
  const ensure = (id: string, role: string) =>
    byId.get(id) ?? put({ id, role, content: "" });

  const appendText = (id: string, role: string, delta: string) => {
    const message = ensure(id, role);
    message.content = `${text(message.content)}${delta}`;
  };

  const startCall = (event: AgUiEvent) => {
    const callId = text(event.toolCallId);
    if (!callId) return;
    const ownerId = text(event.parentMessageId) || callId;
    callOwner.set(callId, ownerId);
    const owner = ensure(ownerId, "assistant");
    owner.toolCalls ??= [];
    if (!owner.toolCalls.some((call) => call.id === callId)) {
      owner.toolCalls.push({
        id: callId,
        name: text(event.toolCallName),
        args: "",
      });
    }
  };
  const appendArgs = (callId: string, delta: string) => {
    const owner = byId.get(callOwner.get(callId) ?? "");
    const call = owner?.toolCalls?.find((entry) => entry.id === callId);
    if (call) call.args += delta;
  };

  for (const event of events) {
    switch (event.type) {
      case "RUN_STARTED": {
        const input = event.input as { messages?: unknown } | undefined;
        if (Array.isArray(input?.messages)) {
          for (const raw of input.messages as ThreadMessage[]) {
            if (raw?.id && !byId.has(raw.id)) put(structuredClone(raw));
          }
        }
        break;
      }
      case "TEXT_MESSAGE_START":
        put({
          id: text(event.messageId),
          role: text(event.role) || "assistant",
          content: "",
        });
        break;
      case "TEXT_MESSAGE_CONTENT":
        appendText(text(event.messageId), "assistant", text(event.delta));
        break;
      case "TEXT_MESSAGE_CHUNK":
        if (event.messageId) {
          appendText(
            text(event.messageId),
            text(event.role) || "assistant",
            text(event.delta),
          );
        }
        break;
      case "TOOL_CALL_START":
        startCall(event);
        break;
      case "TOOL_CALL_ARGS":
        appendArgs(text(event.toolCallId), text(event.delta));
        break;
      case "TOOL_CALL_CHUNK": {
        const callId = text(event.toolCallId);
        if (callId && !callOwner.has(callId)) startCall(event);
        appendArgs(callId, text(event.delta));
        break;
      }
      case "TOOL_CALL_RESULT": {
        const id = text(event.messageId) || `${text(event.toolCallId)}:result`;
        put({
          id,
          role: "tool",
          content: event.content,
          toolCallId: text(event.toolCallId),
        });
        break;
      }
      case "MESSAGES_SNAPSHOT": {
        // A snapshot is the whole list: anything it omits is gone.
        order.length = 0;
        byId.clear();
        callOwner.clear();
        if (Array.isArray(event.messages)) {
          for (const raw of event.messages as ThreadMessage[]) {
            if (raw?.id) put(structuredClone(raw));
          }
        }
        break;
      }
      case "ACTIVITY_SNAPSHOT": {
        const id = text(event.messageId);
        if (id) {
          put({
            id,
            role: "activity",
            activityType: text(event.activityType),
            content: event.content,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return order.map((id) => byId.get(id) as ThreadMessage);
}
