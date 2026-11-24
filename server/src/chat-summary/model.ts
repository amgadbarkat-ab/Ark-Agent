/**
 * The model that writes an employee's weekly summary: the one the person chose (on this computer or
 * with their API key), and the deployment's own model when theirs cannot answer, exactly as a
 * conversation's title is asked (channels/titler.ts). Not a turn: a summary is not said to anybody.
 */
import type { ConnectionLanguageModel } from "../models/language-model";
import { chatCompletionsUrl } from "../routing/model";
import type { SummaryModel } from "./service";

/** A summary is long; reasoning tokens come out of the same budget. */
const MAX_OUTPUT_TOKENS = 4096;

export function summaryModel(options: {
  personal: (userId: string) => Promise<ConnectionLanguageModel | undefined>;
  /** The deployment's model, from the tenant package. */
  model: string;
  resolveApiKey: () => Promise<string | null>;
  environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SummaryModel {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const call = options.fetchImpl ?? fetch;
  return async (userId, instruction, text) => {
    const model = await options.personal(userId).catch(() => undefined);
    if (model) {
      try {
        const result = await model.doGenerate({
          prompt: [
            { role: "system", content: instruction },
            { role: "user", content: [{ type: "text", text }] },
          ],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: AbortSignal.timeout(timeoutMs),
        });
        const answer = result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
          .trim();
        if (answer) return answer;
      } catch {
        // Their model could not answer; the deployment's may.
      }
    }
    const apiKey = await options.resolveApiKey();
    if (!apiKey) return null;
    const response = await call(
      chatCompletionsUrl(options.environment ?? process.env),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: instruction },
            { role: "user", content: text },
          ],
          max_completion_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown } }[];
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim()
      ? content.trim()
      : null;
  };
}
