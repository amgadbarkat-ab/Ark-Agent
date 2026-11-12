/**
 * The host side of the MCP Apps bridge (P2 idea 9B): what the chat answers when an app drawn in a
 * sandboxed frame speaks to it, kept apart from React so it can be tested on its own.
 *
 * The app speaks JSON-RPC 2.0 over `postMessage`. This answers the handshake, hands the app the
 * call's arguments and result, and turns each of its requests into something this host already
 * does safely:
 *  - `ui/message`: a message in the conversation, as if the person typed it;
 *  - `tools/call`: also a message, asking the employee to make the call, so a write waits for the
 *    person's approval and is audited like any other. The frame never runs a tool itself;
 *  - `ui/open-link`: an https address opened in the browser;
 *  - `ui/notifications/size-changed`: the frame's height, within bounds.
 * Anything else is refused with JSON-RPC's "method not found".
 */

export const PROTOCOL_VERSION = "2026-01-26";

/** At most this many messages one app may put in the conversation, and never two within this. */
export const MAX_ASKS = 5;
export const ASK_GAP_MS = 3_000;

export const MIN_HEIGHT = 80;
export const MAX_HEIGHT = 800;

type Json = Record<string, unknown>;

export type BridgeHost = {
  /** Post to the frame. */
  post: (message: Json) => void;
  /** Put a message in the conversation, as the person. */
  ask: (text: string) => void;
  /** Open an https address in the browser. */
  open: (url: string) => void;
  /** The frame's content height changed. */
  resize: (height: number) => void;
  now?: () => number;
};

export type ToolCallView = {
  name: string;
  arguments: Json;
  /** The result as text, once the call has one. */
  result?: string;
};

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A sentence the app wrote, from MCP content blocks or a plain string. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function createBridge(host: BridgeHost, call: ToolCallView) {
  const now = host.now ?? Date.now;
  let asks = 0;
  let lastAsk = Number.NEGATIVE_INFINITY;
  let initialised = false;
  let resultSent = false;

  const reply = (id: unknown, result: Json) =>
    host.post({ jsonrpc: "2.0", id, result });
  const refuse = (id: unknown, code: number, message: string) =>
    host.post({ jsonrpc: "2.0", id, error: { code, message } });
  const notify = (method: string, params: Json) =>
    host.post({ jsonrpc: "2.0", method, params });

  /** Whether the app may put another message in the conversation now. */
  const mayAsk = () => {
    const at = now();
    if (asks >= MAX_ASKS || at - lastAsk < ASK_GAP_MS) return false;
    asks += 1;
    lastAsk = at;
    return true;
  };

  const sendResult = () => {
    if (!initialised || resultSent || call.result === undefined) return;
    resultSent = true;
    notify("ui/notifications/tool-result", {
      content: [{ type: "text", text: call.result }],
      isError: false,
    });
  };

  return {
    /** The call's result arrived after the frame did. */
    update(next: ToolCallView) {
      call = next;
      sendResult();
    },

    receive(message: unknown) {
      if (!isRecord(message) || message.jsonrpc !== "2.0") return;
      const { id, method } = message;
      const params = isRecord(message.params) ? message.params : {};
      if (typeof method !== "string") return;

      switch (method) {
        case "ui/initialize":
          reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: "ArkAgent", version: "1" },
            hostCapabilities: {
              openLinks: {},
              message: {},
              serverTools: {},
            },
            hostContext: {
              displayMode: "inline",
              availableDisplayModes: ["inline"],
              theme:
                typeof document !== "undefined" &&
                document.documentElement.classList.contains("dark")
                  ? "dark"
                  : "light",
            },
          });
          return;
        case "ui/notifications/initialized":
          initialised = true;
          notify("ui/notifications/tool-input", { arguments: call.arguments });
          sendResult();
          return;
        case "ui/notifications/size-changed": {
          const height = Number(params.height);
          if (Number.isFinite(height)) {
            host.resize(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
          }
          return;
        }
        case "ui/open-link": {
          const url = typeof params.url === "string" ? params.url : "";
          if (!url.startsWith("https://")) {
            refuse(id, -32602, "Only https addresses are opened.");
            return;
          }
          host.open(url);
          reply(id, {});
          return;
        }
        case "ui/message": {
          const text = textOf(params.content).trim().slice(0, 2_000);
          if (!text) {
            refuse(id, -32602, "The message was empty.");
            return;
          }
          if (!mayAsk()) {
            refuse(id, -32000, "Too many messages from this app.");
            return;
          }
          host.ask(text);
          reply(id, {});
          return;
        }
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          if (!name || name.length > 120) {
            refuse(id, -32602, "Name the tool to call.");
            return;
          }
          if (!mayAsk()) {
            refuse(id, -32000, "Too many requests from this app.");
            return;
          }
          const args = JSON.stringify(params.arguments ?? {}).slice(0, 2_000);
          host.ask(
            `Please call the ${name} tool with these arguments: ${args}`,
          );
          reply(id, {
            content: [
              {
                type: "text",
                text: "Asked in the conversation. The digital employee makes the call, and anything that changes something waits for approval there.",
              },
            ],
            isError: false,
          });
          return;
        }
        default:
          // Notifications need no answer; a request for something not offered is refused.
          if (id !== undefined) refuse(id, -32601, `${method} is not offered.`);
      }
    },
  };
}

/**
 * The app's HTML with a policy that lets it draw and nothing else: inline script and style, and
 * pictures and fonts carried inside it. No requests anywhere, so nothing it holds can be sent away
 * and nothing it loads can change after review.
 */
export const FRAME_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

export function withPolicy(html: string): string {
  // First in the document, so it is in force before anything the app wrote is parsed. A policy
  // the app adds later can only narrow it: several policies are all enforced.
  const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    return `${doctype[0]}${meta}${html.slice(doctype[0].length)}`;
  }
  return `${meta}${html}`;
}
