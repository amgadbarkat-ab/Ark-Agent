import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { runtimeModelForEnvironment } from "../src/copilot";
import {
  encryptSecret,
  resolveModelApiKey,
  type ModelCredentialSecretReader,
} from "../src/credentials";
import {
  createProviderOAuthProxy,
  mountProviderOAuthProxy,
  type ModelOAuthRecord,
} from "../src/provider-oauth";
import { createVoiceSummarizer } from "../src/voice/summary";

const transcript = [
  { id: "turn-1", role: "user", text: "Plan the launch." },
] as const;
const answer = "Discussed launch planning. Next steps remain open.";
const packageModel = { provider: "openai", defaultModel: "gpt-test" } as const;
const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function summarizer(
  environment: Record<string, string | undefined>,
  reader: ModelCredentialSecretReader = { readModelSecret: async () => null },
) {
  const model = runtimeModelForEnvironment(packageModel, environment);
  return createVoiceSummarizer({
    model,
    environment,
    timeoutMs: 1000,
    resolveApiKey: () =>
      resolveModelApiKey({
        encryptionKey,
        reader,
        provider: model.provider,
        keyId: "primary-model",
        environment,
      }),
  });
}

test.each(["openai", "anthropic"] as const)(
  "voice summaries use the selected %s API credential and protocol, including rotation",
  async (provider) => {
    const seen: {
      path: string;
      authorization: string | null;
      apiKey: string | null;
      body: unknown;
    }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          body: await request.json(),
        });
        return Response.json(
          provider === "anthropic"
            ? {
                content: [
                  { type: "thinking", thinking: "private" },
                  { type: "text", text: answer },
                ],
              }
            : { choices: [{ message: { content: answer } }] },
        );
      },
    });
    try {
      const environment = {
        BOT_PROVIDER: provider,
        BOT_MODEL: "selected-model",
        OPENAI_BASE_URL: `${server.url.origin}/gateway/v1/`,
        ANTHROPIC_BASE_URL: `${server.url.origin}/gateway/v1/`,
        ...(provider === "anthropic"
          ? { ANTHROPIC_API_KEY: "environment-key" }
          : { OPENAI_API_KEY: "environment-key" }),
        VOICE_API_KEY: "must-not-be-used",
      };
      let encryptedValue: string | undefined;
      const summarize = summarizer(environment, {
        readModelSecret: async (input) => {
          expect(input).toEqual({ provider, keyId: "primary-model" });
          return encryptedValue ? { encryptedValue } : null;
        },
      });
      expect(await summarize(transcript)).toBe(answer);
      encryptedValue = await encryptSecret(encryptionKey, "rotated-stored-key");
      expect(await summarize(transcript)).toBe(answer);
      expect(seen).toHaveLength(2);
      for (const [index, request] of seen.entries()) {
        const key = index === 0 ? "environment-key" : "rotated-stored-key";
        expect(request.path).toBe(
          `/gateway/v1/${provider === "anthropic" ? "messages" : "chat/completions"}`,
        );
        expect(request.authorization).toBe(
          provider === "anthropic" ? null : `Bearer ${key}`,
        );
        expect(request.apiKey).toBe(provider === "anthropic" ? key : null);
        expect(request.body).toMatchObject({ model: "selected-model" });
        expect(JSON.stringify(request.body)).toContain("untrusted");
        expect(JSON.stringify(request.body)).toContain("Plan the launch.");
      }
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["google", "xai"] as const)(
  "voice summaries reuse the authenticated native %s OAuth proxy",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "openbot-voice-summary-"));
    const file = join(root, "oauth.json");
    const record: ModelOAuthRecord = {
      version: 1,
      sessionId: "synthetic-session",
      provider,
      clientId: "synthetic-client",
      accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      scope: "model",
      quotaProject: "synthetic-quota",
      proxyToken: "synthetic-proxy-token",
    };
    const received: {
      url: string;
      authorization: string | null;
      body: unknown;
    }[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        return Response.json(
          provider === "google"
            ? {
                candidates: [
                  {
                    content: { parts: [{ text: answer }] },
                    finishReason: "STOP",
                  },
                ],
              }
            : { choices: [{ message: { content: answer } }] },
        );
      },
    });
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await writeFile(file, JSON.stringify(record), { mode: 0o600 });
      const app = new Hono();
      mountProviderOAuthProxy(
        app,
        createProviderOAuthProxy(file, {
          fetch: (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            return fetch(new URL(url.pathname, upstream.url), init);
          },
        }),
      );
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      const environment = {
        BOT_PROVIDER: "openai",
        BOT_MODEL: "selected-model",
        OPENAI_BASE_URL: `${server.url.origin}/api/model-provider/v1`,
        OPENAI_API_KEY: record.proxyToken,
        OPENBOT_MODEL_OAUTH_FILE: file,
      };
      expect(await summarizer(environment)(transcript)).toBe(answer);
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe(`Bearer ${record.accessToken}`);
      expect(new URL(received[0]?.url ?? "").pathname).toBe(
        provider === "google"
          ? "/v1beta/models/selected-model:generateContent"
          : "/v1/chat/completions",
      );
      expect(JSON.stringify(received[0]?.body)).toContain("Plan the launch.");
      expect(JSON.stringify(received[0]?.body)).toContain("untrusted");
      expect(JSON.stringify(received[0]?.body)).not.toContain(
        record.proxyToken,
      );
      await expect(
        summarizer({ ...environment, OPENAI_API_KEY: "wrong-proxy-token" })(
          transcript,
        ),
      ).rejects.toThrow("401");
      expect(received).toHaveLength(1);
    } finally {
      await server?.stop(true);
      await upstream.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
