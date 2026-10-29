import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MAX_SPEECH_CHARACTERS,
  SPEECH_TIMEOUT_MS,
  type SpeechLanguage,
  speechVerdict,
} from "../../../shared/speech";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";
import { SpeechError, type SpeechProvider } from "./provider";

/** The one method of the Intelligence client this route uses, narrowed so a test needs no client. */
export type SpeechTranscript = {
  getThreadMessages(params: { threadId: string; userId: string }): Promise<{
    messages: { id: string; role: string; content?: unknown }[];
  }>;
};

export type SpeechServices = {
  provider: SpeechProvider;
  voices: Partial<Record<SpeechLanguage, string>>;
  channels: Pick<ChannelStore, "get">;
  transcript: SpeechTranscript;
  /** How long one message may take. Settable so a test need not wait out the real limit. */
  timeoutMs?: number;
};

const LANGUAGE_NAMES: Record<SpeechLanguage, string> = {
  ar: "Arabic",
  en: "English",
};

/** One graphics card serves every request, so a handful at once is already a queue. */
const MAX_ACTIVE = 4;

/**
 * Read one of a digital employee's messages aloud.
 *
 * The browser names a message, never the words: the server loads the text from the person's own
 * thread in a conversation they are a member of, so nobody can have arbitrary text spoken, and
 * nobody can hear a message from a conversation they cannot open. The language is decided here from
 * that text, and anything that is not Arabic or English (Greek above all) is refused before a byte
 * leaves for the speech endpoint.
 *
 * The message itself is never logged. A failure logs what kind of failure it was and nothing said.
 */
export function createSpeechRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  services: SpeechServices | undefined,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const active = new Set<string>();
  app.use("*", requireUser);
  app.post(
    "/",
    async (context, next) => {
      context.header("Cache-Control", "no-store");
      // Off is absent, not broken: there is no Read aloud on this deployment to be unavailable.
      if (!services)
        return context.json(
          { error: "Read aloud is not enabled on this deployment." },
          404,
        );
      // A cross-origin HTML form cannot send JSON, and this route grants no CORS access.
      if (
        context.req.header("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      ) {
        return context.json({ error: "A JSON request is required." }, 415);
      }
      await next();
    },
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (context) =>
        context.json({ error: "Read aloud request is too large." }, 413),
    }),
    async (context) => {
      if (!services)
        return context.json(
          { error: "Read aloud is not enabled on this deployment." },
          404,
        );
      const body: unknown = await context.req.json().catch(() => null);
      const channelId = field(body, "channelId");
      const messageId = field(body, "messageId");
      if (!channelId || !messageId) {
        return context.json(
          { error: "A conversation and a message are required." },
          400,
        );
      }
      const actor = context.var.actor;

      let channel: Awaited<ReturnType<ChannelStore["get"]>>;
      try {
        // Scoped to the person: a conversation they are not a member of reads as not found.
        channel = await services.channels.get(actor, channelId);
      } catch {
        return context.json(
          { error: "The conversation could not be loaded. Please retry." },
          503,
        );
      }
      if (!channel)
        return context.json({ error: "Conversation not found." }, 404);

      let content: unknown;
      try {
        // The person's own thread, read as them: threads are per person even in a shared channel.
        const history = await services.transcript.getThreadMessages({
          threadId: channel.threadId,
          userId: actor.id,
        });
        const message = history.messages.find(
          (candidate) =>
            candidate.id === messageId && candidate.role === "assistant",
        );
        if (!message) return context.json({ error: "Message not found." }, 404);
        content = message.content;
      } catch {
        return context.json(
          { error: "The conversation could not be loaded. Please retry." },
          503,
        );
      }

      const verdict = speechVerdict(textOf(content));
      if (!verdict.ok) {
        return verdict.reason === "language"
          ? context.json(
              {
                error:
                  "Read aloud speaks Arabic and English only. This message is in another language, so it was not sent to the speech service.",
              },
              422,
            )
          : verdict.reason === "length"
            ? context.json(
                {
                  error: `This message is too long to read aloud (over ${MAX_SPEECH_CHARACTERS.toLocaleString("en")} characters).`,
                },
                413,
              )
            : context.json(
                { error: "This message has nothing to read aloud." },
                422,
              );
      }
      const voice = services.voices[verdict.language];
      if (!voice) {
        return context.json(
          {
            error: `Read aloud is not set up for ${LANGUAGE_NAMES[verdict.language]} on this deployment.`,
          },
          422,
        );
      }

      if (active.has(actor.id) || active.size >= MAX_ACTIVE) {
        context.header("Retry-After", "10");
        return context.json(
          {
            error: "Another message is being read aloud. Please retry shortly.",
          },
          429,
        );
      }
      active.add(actor.id);
      const signal = AbortSignal.any([
        context.req.raw.signal,
        AbortSignal.timeout(services.timeoutMs ?? SPEECH_TIMEOUT_MS),
      ]);
      try {
        const speech = await services.provider.synthesize(
          { text: verdict.text, voice },
          signal,
        );
        return context.body(speech.audio as Uint8Array<ArrayBuffer>, 200, {
          "Content-Type": speech.mediaType,
          "Content-Length": String(speech.audio.byteLength),
          "X-Content-Type-Options": "nosniff",
        });
      } catch (error) {
        const timedOut = signal.aborted;
        console.warn(
          JSON.stringify({
            type: "speech-failed",
            reason: timedOut
              ? "timeout"
              : error instanceof SpeechError
                ? "upstream"
                : "unreachable",
            language: verdict.language,
            characters: verdict.text.length,
          }),
        );
        if (timedOut) {
          return context.json(
            {
              error: "Read aloud timed out or was cancelled. Please retry.",
            },
            504,
          );
        }
        return context.json(
          {
            error:
              error instanceof SpeechError
                ? error.message
                : "The speech service could not be reached. Please retry.",
          },
          502,
        );
      } finally {
        active.delete(actor.id);
      }
    },
  );
  return app;
}

function field(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== "object" || !(name in body)) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() && value.length <= 256
    ? value
    : undefined;
}

/* `content` is a string or an array of parts; anything else is no text, not `[object Object]`. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}
