import type { SpeechLanguage } from "../../../shared/speech";

export type SpeechConfig = {
  /** Base URL of an OpenAI-compatible speech API, including its version path. */
  baseUrl: string;
  model: string;
  /** The voice for each language this deployment speaks. A language with no voice is not spoken. */
  voices: Partial<Record<SpeechLanguage, string>>;
  apiKey?: string;
  /**
   * The credit the model's licence asks to be shown wherever it is used, e.g. "Powered by KittenML".
   * Configuration rather than code, so changing the engine changes the credit with it.
   */
  attribution?: string;
};

/**
 * Read aloud is separately opted in. Nothing else (chat, dictation, live voice) enables it, and with
 * every SPEECH_ variable unset it does not exist: no route answers and the browser offers nothing.
 *
 * The engine is whatever answers the OpenAI speech contract at SPEECH_URL. The approved one needs a
 * graphics card, which this server cannot see; that is enforced where the engine is started (the
 * `speech` Compose profile reserves an NVIDIA GPU) and described in docs/ark/27-read-aloud.md.
 */
export function speechConfig(
  environment: Record<string, string | undefined>,
): SpeechConfig | undefined {
  const baseUrl = environment.SPEECH_URL?.trim();
  const model = environment.SPEECH_MODEL?.trim();
  const english = environment.SPEECH_VOICE_EN?.trim();
  const arabic = environment.SPEECH_VOICE_AR?.trim();
  const apiKey = environment.SPEECH_API_KEY?.trim();
  const attribution = environment.SPEECH_ATTRIBUTION?.trim();
  if (!baseUrl && !model && !english && !arabic && !apiKey && !attribution)
    return undefined;
  if (!baseUrl || !model) {
    throw new Error("SPEECH_URL and SPEECH_MODEL are required for Read aloud.");
  }
  if (!english && !arabic) {
    throw new Error(
      "Read aloud needs SPEECH_VOICE_EN, SPEECH_VOICE_AR, or both.",
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("SPEECH_URL must be an HTTP(S) URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SPEECH_URL must be HTTP(S), without credentials, query, or fragment.",
    );
  }
  return {
    baseUrl: url.href.replace(/\/+$/, ""),
    model,
    voices: {
      ...(english ? { en: english } : {}),
      ...(arabic ? { ar: arabic } : {}),
    },
    ...(apiKey ? { apiKey } : {}),
    ...(attribution ? { attribution } : {}),
  };
}
