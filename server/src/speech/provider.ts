import type { SpeechConfig } from "./config";

/** The most audio one message may come back as. Four thousand characters of 24 kHz WAV is ~12 MiB. */
export const MAX_SPEECH_AUDIO_BYTES = 32 * 1024 * 1024;

export type SpeechAudio = { audio: Uint8Array; mediaType: string };

export interface SpeechProvider {
  synthesize(
    input: { text: string; voice: string },
    signal: AbortSignal,
  ): Promise<SpeechAudio>;
}

/** A safe, actionable message; upstream response bodies can contain deployment secrets. */
export class SpeechError extends Error {}

type Transport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The audio types a browser can play, by what an OpenAI-compatible server may call them.
 *
 * The answer's own type is never passed through: it is mapped to one of these or refused, so a
 * misbehaving engine cannot hand the browser HTML or a script under an audio route.
 */
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "audio/aac": "audio/aac",
  "audio/flac": "audio/flac",
  "audio/webm": "audio/webm",
};

/**
 * Speech from any server that answers OpenAI's `POST /audio/speech` contract.
 *
 * Nothing here names an engine. The one the owner approved runs behind this contract in its own
 * container, and a later engine that speaks Greek would be another URL, not another adapter.
 */
export function createSpeechProvider(
  config: SpeechConfig,
  transport: Transport = fetch,
): SpeechProvider {
  return {
    async synthesize({ text, voice }, signal) {
      const response = await transport(`${config.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey
            ? { authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ model: config.model, input: text, voice }),
        signal,
        // A redirect must never send a person's message to an unconfigured destination.
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechError(
          response.status === 429 || response.status === 503
            ? "The speech service is busy. Please retry shortly."
            : "The speech service could not read this message aloud. Retry or contact your administrator.",
        );
      }
      const declared =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      const mediaType = Object.hasOwn(AUDIO_TYPES, declared.toLowerCase())
        ? AUDIO_TYPES[declared.toLowerCase()]
        : undefined;
      if (!mediaType) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechError(
          "The speech service returned something that is not audio.",
        );
      }
      const audio = await readCapped(response, MAX_SPEECH_AUDIO_BYTES);
      if (!audio.byteLength) {
        throw new SpeechError("The speech service returned no audio.");
      }
      return { audio, mediaType };
    },
  };
}

/** Read the whole answer, refusing one larger than `limit` rather than holding it all first. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new SpeechError("The speech service returned too much audio.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new SpeechError("The speech service returned too much audio.");
    }
    chunks.push(value);
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}
