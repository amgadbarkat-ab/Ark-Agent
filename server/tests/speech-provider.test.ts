import { describe, expect, test } from "bun:test";
import { speechConfig } from "../src/speech/config";
import {
  createSpeechProvider,
  MAX_SPEECH_AUDIO_BYTES,
  SpeechError,
} from "../src/speech/provider";

const environment = {
  SPEECH_URL: "http://127.0.0.1:4210/v1/",
  SPEECH_MODEL: "speech-model",
  SPEECH_VOICE_EN: "english-voice",
  SPEECH_VOICE_AR: "arabic-voice",
};

describe("Read aloud configuration", () => {
  test("is off unless its own variables are set", () => {
    expect(speechConfig({})).toBeUndefined();
    expect(
      speechConfig({
        OPENAI_API_KEY: "chat-key",
        TRANSCRIPTION_BASE_URL: "https://speech.example/v1",
        VOICE_NAME: "marin",
      }),
    ).toBeUndefined();
  });

  test("needs an endpoint, a model and at least one voice", () => {
    expect(() => speechConfig({ SPEECH_VOICE_EN: "voice" })).toThrow(
      "SPEECH_URL and SPEECH_MODEL",
    );
    expect(() =>
      speechConfig({ SPEECH_URL: environment.SPEECH_URL, SPEECH_MODEL: "m" }),
    ).toThrow("SPEECH_VOICE_EN");
    expect(() =>
      speechConfig({ ...environment, SPEECH_URL: "file:///tmp/speech" }),
    ).toThrow("HTTP(S)");
    expect(() =>
      speechConfig({
        ...environment,
        SPEECH_URL: "https://user:pass@speech.example/v1",
      }),
    ).toThrow("without credentials");
  });

  test("keeps only the voices it was given", () => {
    expect(
      speechConfig({
        SPEECH_URL: environment.SPEECH_URL,
        SPEECH_MODEL: "speech-model",
        SPEECH_VOICE_AR: "arabic-voice",
        SPEECH_ATTRIBUTION: "Powered by Example",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:4210/v1",
      model: "speech-model",
      voices: { ar: "arabic-voice" },
      attribution: "Powered by Example",
    });
  });
});

describe("the OpenAI-compatible speech adapter", () => {
  const config = {
    baseUrl: "http://127.0.0.1:4210/v1",
    model: "speech-model",
    voices: { en: "english-voice" },
    apiKey: "speech-key",
  };

  test("posts model, input and voice and returns the audio with a mapped type", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = createSpeechProvider(config, async (url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/x-wav" },
      });
    });
    const speech = await provider.synthesize(
      { text: "Hello", voice: "english-voice" },
      new AbortController().signal,
    );
    expect(speech.mediaType).toBe("audio/wav");
    expect([...speech.audio]).toEqual([1, 2, 3]);
    const [sent] = calls;
    if (!sent) throw new Error("The adapter sent nothing.");
    expect(sent.url).toBe("http://127.0.0.1:4210/v1/audio/speech");
    expect(sent.init.redirect).toBe("error");
    expect((sent.init.headers as Record<string, string>).authorization).toBe(
      "Bearer speech-key",
    );
    expect(JSON.parse(String(sent.init.body))).toEqual({
      model: "speech-model",
      input: "Hello",
      voice: "english-voice",
    });
  });

  test("never passes on the upstream's words, or anything that is not audio", async () => {
    const failing = createSpeechProvider(
      config,
      async () => new Response("secret upstream detail", { status: 500 }),
    );
    const error = await failing
      .synthesize({ text: "Hi", voice: "v" }, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechError);
    expect(String(error)).not.toContain("secret");

    const html = createSpeechProvider(
      config,
      async () =>
        new Response("<script>", { headers: { "content-type": "text/html" } }),
    );
    await expect(
      html.synthesize({ text: "Hi", voice: "v" }, new AbortController().signal),
    ).rejects.toThrow("not audio");
  });

  test("refuses an answer larger than the cap", async () => {
    const huge = createSpeechProvider(
      config,
      async () =>
        new Response(new Uint8Array(8), {
          headers: {
            "content-type": "audio/mpeg",
            "content-length": String(MAX_SPEECH_AUDIO_BYTES + 1),
          },
        }),
    );
    await expect(
      huge.synthesize({ text: "Hi", voice: "v" }, new AbortController().signal),
    ).rejects.toThrow("too much audio");
  });
});
