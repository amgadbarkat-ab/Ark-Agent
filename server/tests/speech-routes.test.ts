import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { MAX_SPEECH_CHARACTERS } from "../../shared/speech";
import type { AppVariables } from "../src/auth/guards";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import { createSpeechProvider } from "../src/speech/provider";
import {
  createSpeechRoutes,
  type SpeechServices,
  type SpeechTranscript,
} from "../src/speech/routes";

const actor = {
  id: "user-1",
  email: "person@example.com",
  role: "user",
} as const;
const user: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const channel: AgentChannel = {
  id: "channel-1",
  name: "Research",
  agentIds: ["agent-1"],
  threadId: "thread-1",
  active: true,
  lastMessageAt: new Date(),
};

/** Only user-1 is a member of channel-1; everything else reads as not found, as the store does. */
const channels: Pick<ChannelStore, "get"> = {
  get: async (who, channelId) =>
    who.id === actor.id && channelId === channel.id ? channel : null,
};

const MESSAGES: Record<string, string> = {
  english: "The **quarterly report** is ready.",
  arabic: "التقرير الفصلي جاهز.",
  greek: "Η τριμηνιαία αναφορά είναι έτοιμη.",
  "english-with-greek": "Confidence is about 0.9 (σ = 0.1).",
  long: "word ".repeat(MAX_SPEECH_CHARACTERS),
  empty: "```\nprint(1)\n```",
};

const transcriptCalls: { threadId: string; userId: string }[] = [];
const transcript: SpeechTranscript = {
  getThreadMessages: async (params) => {
    transcriptCalls.push(params);
    return {
      messages: [
        { id: "asked", role: "user", content: "Read me something" },
        ...Object.entries(MESSAGES).map(([id, content]) => ({
          id,
          role: "assistant",
          content: [{ type: "text", text: content }],
        })),
      ],
    };
  },
};

/** A stand-in for the speech container: it records what reached it and answers with audio. */
const received: { model: string; input: string; voice: string }[] = [];
let upstreamStatus = 200;
let upstreamDelayMs = 0;
let upstream: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/audio/speech")
        return new Response("not here", { status: 404 });
      received.push(await request.json());
      if (upstreamDelayMs) await Bun.sleep(upstreamDelayMs);
      if (upstreamStatus !== 200)
        return new Response("internal detail", { status: upstreamStatus });
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      });
    },
  });
});
afterAll(() => upstream.stop(true));

function routes(overrides: Partial<SpeechServices> = {}) {
  return createSpeechRoutes(user, {
    provider: createSpeechProvider({
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      model: "speech-model",
      voices: {},
    }),
    voices: { en: "NewsVoice", ar: "ArabicVoice" },
    channels,
    transcript,
    ...overrides,
  });
}

function read(messageId: string, channelId = channel.id): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId, messageId }),
  };
}

function reset() {
  received.length = 0;
  transcriptCalls.length = 0;
  upstreamStatus = 200;
  upstreamDelayMs = 0;
}

test("off means not found, and nothing is read or sent", async () => {
  reset();
  const app = createSpeechRoutes(user, undefined);
  const response = await app.request("/", read("english"));
  expect(response.status).toBe(404);
  expect((await response.json()).error).toContain("not enabled");
  expect(received).toHaveLength(0);
});

test("requires a signed-in person before anything else", async () => {
  reset();
  const app = createSpeechRoutes(
    (context) => context.json({ error: "Authentication required." }, 401),
    {
      provider: { synthesize: () => Promise.reject(new Error("never")) },
      voices: { en: "v" },
      channels,
      transcript,
    },
  );
  expect((await app.request("/", read("english"))).status).toBe(401);
  expect(transcriptCalls).toHaveLength(0);
});

test("reads an English message in the English voice and returns the audio", async () => {
  reset();
  const response = await routes().request("/", read("english"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
    82, 73, 70, 70,
  ]);
  // The markdown is gone, and the text came from the person's own thread, not the request.
  expect(received).toEqual([
    {
      model: "speech-model",
      input: "The quarterly report is ready.",
      voice: "NewsVoice",
    },
  ]);
  expect(transcriptCalls).toEqual([{ threadId: "thread-1", userId: "user-1" }]);
});

test("reads an Arabic message in the Arabic voice", async () => {
  reset();
  const response = await routes().request("/", read("arabic"));
  expect(response.status).toBe(200);
  expect(received[0]?.voice).toBe("ArabicVoice");
  expect(received[0]?.input).toBe("التقرير الفصلي جاهز.");
});

test("Greek is refused with a clear sentence and never reaches the speech service", async () => {
  reset();
  for (const id of ["greek", "english-with-greek"]) {
    const response = await routes().request("/", read(id));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("Arabic and English only");
  }
  expect(received).toHaveLength(0);
});

test("a language with no configured voice is refused, not spoken in another voice", async () => {
  reset();
  const response = await routes({ voices: { en: "NewsVoice" } }).request(
    "/",
    read("arabic"),
  );
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("Arabic");
  expect(received).toHaveLength(0);
});

test("too long and nothing to say are refused before sending", async () => {
  reset();
  const long = await routes().request("/", read("long"));
  expect(long.status).toBe(413);
  expect((await long.json()).error).toContain("too long");
  expect((await routes().request("/", read("empty"))).status).toBe(422);
  expect(received).toHaveLength(0);
});

test("only a conversation the person is in, and only a digital employee's message", async () => {
  reset();
  const elsewhere = await routes().request("/", read("english", "channel-2"));
  expect(elsewhere.status).toBe(404);
  // Someone else asking for the same channel and message is not found either.
  const stranger = createSpeechRoutes(
    async (context, next) => {
      context.set("actor", {
        id: "user-2",
        email: "x@example.com",
        role: "user",
      });
      await next();
    },
    {
      provider: createSpeechProvider({
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        model: "speech-model",
        voices: {},
      }),
      voices: { en: "NewsVoice" },
      channels,
      transcript,
    },
  );
  expect((await stranger.request("/", read("english"))).status).toBe(404);
  // The person's own message is not read aloud, and an unknown id is not found.
  expect((await routes().request("/", read("asked"))).status).toBe(404);
  expect((await routes().request("/", read("missing"))).status).toBe(404);
  expect(received).toHaveLength(0);
  expect(transcriptCalls.every((call) => call.userId === "user-1")).toBe(true);
});

test("rejects malformed and cross-site requests", async () => {
  reset();
  const app = routes();
  expect(
    (
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "channelId=channel-1&messageId=english",
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: channel.id }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: channel.id, text: "x".repeat(8000) }),
      })
    ).status,
  ).toBe(413);
  expect(received).toHaveLength(0);
});

test("an upstream failure is a 502 that does not repeat the upstream's words", async () => {
  reset();
  upstreamStatus = 500;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await routes().request("/", read("english"));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain("internal detail");
    // Logged without the message: the text is the one thing that must not be in a log line.
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("speech-failed");
    expect(logged).not.toContain("quarterly");
  } finally {
    warn.mockRestore();
  }
  upstreamStatus = 503;
  const busy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await routes().request("/", read("english"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("busy");
  } finally {
    busy.mockRestore();
  }
});

test("a slow upstream times out as a 504", async () => {
  reset();
  upstreamDelayMs = 500;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await routes({ timeoutMs: 50 }).request(
      "/",
      read("english"),
    );
    expect(response.status).toBe(504);
    expect((await response.json()).error).toContain("timed out");
  } finally {
    warn.mockRestore();
  }
});

test("an unreachable upstream is a 502", async () => {
  reset();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await routes({
      provider: createSpeechProvider({
        baseUrl: "http://127.0.0.1:1/v1",
        model: "speech-model",
        voices: {},
      }),
    }).request("/", read("english"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("could not be reached");
  } finally {
    warn.mockRestore();
  }
});

test("one message at a time per person", async () => {
  reset();
  const release = Promise.withResolvers<void>();
  const app = routes({
    provider: {
      synthesize: async () => {
        await release.promise;
        return { audio: new Uint8Array([1]), mediaType: "audio/mpeg" };
      },
    },
  });
  const first = app.request("/", read("english"));
  await Bun.sleep(10);
  expect((await app.request("/", read("arabic"))).status).toBe(429);
  release.resolve();
  expect((await first).status).toBe(200);
});
