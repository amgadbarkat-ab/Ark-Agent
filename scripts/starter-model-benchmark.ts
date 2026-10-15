#!/usr/bin/env bun
/**
 * Measures an OpenAI-compatible model server the way the starter model will be used: one person, then
 * two, then three asking at the same moment, each streaming an answer.
 *
 *   bun scripts/starter-model-benchmark.ts --url https://starter.example.eu/v1 --token <token> \
 *     --model gemma-4-e4b --users 1,2,3 --max-tokens 120
 *
 * It exists because the speed of a small model on two Arm cores is a guess until somebody measures it,
 * and the choice between Gemma 4 E4B and the smaller E2B is made from these numbers
 * (docs/ark/22-starter-model.md). Run it ON the server for the model's own speed, and from the machine
 * that hosts Ark for the speed a person will see.
 *
 * What it reports per level of concurrency: time to the first word, and words-per-second after it,
 * for each person, and the slowest. "Tokens" are counted from the server's usage report when it sends
 * one and from streamed pieces otherwise, which undercounts a little; the line says which.
 */

const PROMPTS: Record<string, string> = {
  english:
    "Write a short, friendly reply to a customer who asks when their invoice will be paid. Keep it under 80 words.",
  greek:
    "Γράψε μια σύντομη, φιλική απάντηση σε έναν πελάτη που ρωτά πότε θα πληρωθεί το τιμολόγιό του. Έως 80 λέξεις.",
};

type Options = {
  url: string;
  token: string | undefined;
  model: string;
  users: number[];
  maxTokens: number;
  prompt: keyof typeof PROMPTS;
  timeoutSeconds: number;
  json: boolean;
};

export type Sample = {
  ok: boolean;
  error?: string;
  /** Seconds from asking to the first piece of the answer. */
  firstWordSeconds?: number;
  totalSeconds: number;
  tokens: number;
  tokensSource: "usage" | "pieces";
  /** Tokens per second after the first word. */
  tokensPerSecond?: number;
};

export function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (flag === "--json") {
      values.set("json", "true");
    } else if (next !== undefined && !next.startsWith("--")) {
      values.set(flag.slice(2), next);
      index += 1;
    }
  }
  const url = values.get("url") ?? process.env.ARK_STARTER_MODEL_URL;
  if (!url) {
    throw new Error("Give --url (or set ARK_STARTER_MODEL_URL).");
  }
  const users = (values.get("users") ?? "1,2,3")
    .split(",")
    .map((part) => Number(part.trim()));
  if (
    users.some((count) => !Number.isInteger(count) || count < 1 || count > 16)
  ) {
    throw new Error("--users must be whole numbers from 1 to 16, like 1,2,3.");
  }
  const prompt = (values.get("prompt") ?? "english") as keyof typeof PROMPTS;
  if (!(prompt in PROMPTS)) {
    throw new Error(
      `--prompt must be one of ${Object.keys(PROMPTS).join(", ")}.`,
    );
  }
  return {
    url: url.replace(/\/+$/, ""),
    token: values.get("token") ?? process.env.ARK_STARTER_MODEL_TOKEN,
    model:
      values.get("model") ??
      process.env.ARK_STARTER_MODEL_NAME ??
      "gemma-4-e4b",
    users,
    maxTokens: Number(values.get("max-tokens") ?? 120),
    prompt,
    timeoutSeconds: Number(values.get("timeout") ?? 300),
    json: values.get("json") === "true",
  };
}

/** One person asking, streaming, timed. */
export async function sample(options: Options): Promise<Sample> {
  const started = performance.now();
  let first: number | undefined;
  let pieces = 0;
  let usageTokens: number | undefined;
  try {
    const response = await fetch(`${options.url}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens,
        messages: [{ role: "user", content: PROMPTS[options.prompt] }],
      }),
      signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
    });
    if (!response.ok || !response.body) {
      return {
        ok: false,
        error: `HTTP ${response.status}`,
        totalSeconds: (performance.now() - started) / 1000,
        tokens: 0,
        tokensSource: "pieces",
      };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { completion_tokens?: number };
          };
          if (chunk.usage?.completion_tokens !== undefined) {
            usageTokens = chunk.usage.completion_tokens;
          }
          if (chunk.choices?.[0]?.delta?.content) {
            first ??= performance.now();
            pieces += 1;
          }
        } catch {
          // A line that is not JSON is not a piece of the answer.
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      totalSeconds: (performance.now() - started) / 1000,
      tokens: pieces,
      tokensSource: "pieces",
    };
  }
  const ended = performance.now();
  const tokens = usageTokens ?? pieces;
  const afterFirst = first === undefined ? 0 : (ended - first) / 1000;
  return {
    ok: first !== undefined,
    ...(first === undefined ? { error: "no answer came back" } : {}),
    ...(first === undefined
      ? {}
      : { firstWordSeconds: (first - started) / 1000 }),
    totalSeconds: (ended - started) / 1000,
    tokens,
    tokensSource: usageTokens === undefined ? "pieces" : "usage",
    ...(afterFirst > 0 && tokens > 1
      ? { tokensPerSecond: (tokens - 1) / afterFirst }
      : {}),
  };
}

export type Level = {
  users: number;
  samples: Sample[];
  /** Slowest first word among the people who got an answer. */
  worstFirstWordSeconds: number | undefined;
  /** The slowest person's speed after their first word. */
  worstTokensPerSecond: number | undefined;
  failures: number;
};

export function summarise(users: number, samples: Sample[]): Level {
  const answered = samples.filter((one) => one.ok);
  const firsts = answered
    .map((one) => one.firstWordSeconds)
    .filter((value): value is number => value !== undefined);
  const speeds = answered
    .map((one) => one.tokensPerSecond)
    .filter((value): value is number => value !== undefined);
  return {
    users,
    samples,
    worstFirstWordSeconds: firsts.length ? Math.max(...firsts) : undefined,
    worstTokensPerSecond: speeds.length ? Math.min(...speeds) : undefined,
    failures: samples.length - answered.length,
  };
}

const fixed = (value: number | undefined, digits = 1) =>
  value === undefined ? "-" : value.toFixed(digits);

export function render(options: Options, levels: Level[]): string {
  const lines = [
    `Model ${options.model} at ${options.url}, prompt "${options.prompt}", up to ${options.maxTokens} tokens`,
    "",
    "people  first word (slowest)  speed (slowest person)  failures",
  ];
  for (const level of levels) {
    lines.push(
      `${String(level.users).padEnd(8)}${`${fixed(level.worstFirstWordSeconds)} s`.padEnd(23)}${`${fixed(level.worstTokensPerSecond)} tokens/s`.padEnd(24)}${level.failures}`,
    );
  }
  const counted = new Set(
    levels.flatMap((level) => level.samples.map((one) => one.tokensSource)),
  );
  lines.push(
    "",
    counted.has("pieces")
      ? "Tokens counted from streamed pieces where the server sent no usage report: a small undercount."
      : "Tokens from the server's own usage report.",
  );
  const one = levels.find((level) => level.users === 1);
  if (one?.worstTokensPerSecond !== undefined) {
    lines.push(
      one.worstTokensPerSecond < 3
        ? "One person gets under 3 tokens a second: too slow. Try the smaller model."
        : "One person gets 3 tokens a second or more: usable for a first message.",
    );
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const levels: Level[] = [];
  for (const count of options.users) {
    const samples = await Promise.all(
      Array.from({ length: count }, () => sample(options)),
    );
    levels.push(summarise(count, samples));
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        { options: { ...options, token: undefined }, levels },
        null,
        2,
      ),
    );
  } else {
    console.log(render(options, levels));
  }
  if (levels.every((level) => level.failures === level.samples.length)) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
