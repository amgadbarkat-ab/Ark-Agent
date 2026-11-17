/**
 * The one model endpoint `ark-eval` talks to (#116): an OpenAI-compatible chat-completions API on a
 * free key. OpenRouter's free tier by default (COO, 17 Nov: Groq's signup was blocked, BlackArk's key
 * is OpenRouter "ArkAgent-116"); Groq and Cerebras remain as alternatives.
 *
 * NEVER: the local model, an Anthropic key, DeepSeek. The CLI can only name the providers below,
 * `assertAllowedEndpoint` refuses an Anthropic or DeepSeek address on any path in, and
 * `assertAllowedModel` refuses Anthropic and DeepSeek models, which OpenRouter can otherwise route
 * to. Only made-up test questions and BlackArk's own instruction text are ever sent: OpenRouter's
 * free models may be served by providers that keep prompts, so nothing else may go there.
 *
 * THE KEY. Taken from `ARK_EVAL_API_KEY` or a masked prompt by the CLI, held in this closure, and
 * sent only in the Authorization header. Every error that could carry text from the endpoint is
 * passed through `redact` first, so an endpoint that echoes the key back cannot put it on screen.
 */

export const PROVIDERS = {
  openrouter: {
    name: "OpenRouter (free tier)",
    baseUrl: "https://openrouter.ai/api/v1",
    // A free (":free") model; the list changes, so --model or ARK_EVAL_MODEL overrides it.
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  },
  groq: {
    name: "Groq (free tier)",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
  },
  cerebras: {
    name: "Cerebras (free tier)",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
  },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Ask for a JSON object back (the judge and the proposer). */
  json?: boolean;
};

export type ChatReply = { content: string; toolCalls: ToolCall[] };

export type ChatClient = {
  /** Where it talks to, for the report. Never the key. */
  readonly label: string;
  chat(request: ChatRequest): Promise<ChatReply>;
};

export class ArkEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArkEvalError";
  }
}

/** Every occurrence of the key replaced, so nothing printed or written can carry it. */
export function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("[key hidden]");
}

/** Refuses the endpoints and keys #116 rules out, whichever way they arrive. */
/** OpenRouter can route to any vendor's model: never Anthropic's or DeepSeek's (#116). */
export function assertAllowedModel(model: string): void {
  const id = model.trim().toLowerCase();
  if (/(^|\/)(anthropic|claude)/.test(id) || id.includes("claude")) {
    throw new ArkEvalError(
      `ark-eval never uses Anthropic's models (#116): ${model}`,
    );
  }
  if (id.includes("deepseek")) {
    throw new ArkEvalError(
      `ark-eval never sends anything to DeepSeek (#116): ${model}`,
    );
  }
}

export function assertAllowedEndpoint(baseUrl: string, apiKey: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new ArkEvalError(`${baseUrl} is not a web address.`);
  }
  if (host.includes("anthropic") || host.includes("claude.ai")) {
    throw new ArkEvalError("ark-eval never uses Anthropic's API (#116).");
  }
  if (host.includes("deepseek")) {
    throw new ArkEvalError("ark-eval never sends anything to DeepSeek (#116).");
  }
  if (apiKey.startsWith("sk-ant-")) {
    throw new ArkEvalError(
      "That looks like an Anthropic key. ark-eval never uses one: give the Groq or Cerebras free key.",
    );
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  label: string;
  fetch?: Fetch;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Tries per request when the endpoint is busy (429) or failing (5xx). */
  attempts?: number;
};

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function makeClient(options: ClientOptions): ChatClient {
  assertAllowedEndpoint(options.baseUrl, options.apiKey);
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? realSleep;
  const attempts = options.attempts ?? 4;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const hide = (text: string) => redact(text, options.apiKey);

  async function chat(request: ChatRequest): Promise<ChatReply> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: 0,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    });
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body,
        });
      } catch (error) {
        throw new ArkEvalError(
          hide(
            `Could not reach ${options.label}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < attempts
      ) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(
          Number.isFinite(after) && after > 0
            ? Math.min(after, 60) * 1000
            : 2 ** attempt * 1000,
        );
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new ArkEvalError(
          hide(
            `${options.label} answered ${response.status}${response.status === 401 ? " (the key was refused)" : ""}: ${text.slice(0, 300)}`,
          ),
        );
      }
      let parsed: {
        choices?: {
          message?: { content?: string | null; tool_calls?: ToolCall[] };
        }[];
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ArkEvalError(
          `${options.label} sent a reply that is not JSON.`,
        );
      }
      const message = parsed.choices?.[0]?.message;
      if (!message) {
        throw new ArkEvalError(
          `${options.label} sent a reply with no message.`,
        );
      }
      return {
        content: message.content ?? "",
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      };
    }
  }

  return { label: options.label, chat };
}

/** The first JSON object in a model's reply, which may wrap it in prose or a code fence. */
export function jsonFrom(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
