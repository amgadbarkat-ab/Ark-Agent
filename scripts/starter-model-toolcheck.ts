#!/usr/bin/env bun
/**
 * Asks an OpenAI-compatible model to do the things a bot does, and counts how often it does them right:
 * call the right tool with arguments that are valid and complete, in English, Greek and Arabic, and NOT call a
 * tool when none is wanted.
 *
 *   bun scripts/starter-model-toolcheck.ts --url http://127.0.0.1:8080/v1 --token <token> \
 *     --model gemma-4-e2b --repeats 3
 *
 * A hosted model, with its key in an environment variable rather than on the command line:
 *
 *   bun scripts/starter-model-toolcheck.ts --url https://api.inceptionlabs.ai/v1 \
 *     --token-env INCEPTION_API_KEY --model mercury-3 --repeats 3
 *
 * It exists because "native support for structured tool use" is on the model card and "works through
 * llama.cpp with our bot prompt" is not, and a small model that answers well but cannot call a tool is
 * no use as the starter model (docs/ark/22-starter-model.md). It reports; it does not gate. The one
 * thing that fails the run is a server that cannot be reached, because then there is nothing to report.
 */

export type Tool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
};

export const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Put an event in the calendar.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601 date and time" },
          duration_minutes: { type: "integer" },
        },
        required: ["title", "start", "duration_minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

export type Case = {
  id: string;
  language: "english" | "greek" | "arabic";
  prompt: string;
  /** The tool that should be called, or null when the right answer is words only. */
  expect: null | {
    tool: string;
    /** Each argument must contain this text (compared without case). */
    contains?: Record<string, string>;
    /** Each argument must equal this value. */
    equals?: Record<string, string | number>;
  };
};

export const CASES: Case[] = [
  {
    id: "email-en",
    language: "english",
    prompt:
      "Email anna@example.com and tell her that invoice 1042 will be paid on Friday.",
    expect: {
      tool: "send_email",
      contains: { to: "anna@example.com", body: "1042" },
    },
  },
  {
    id: "email-el",
    language: "greek",
    prompt:
      "Στείλε email στον nikos@example.com ότι η συνάντηση μετατίθεται για την Τρίτη.",
    expect: { tool: "send_email", contains: { to: "nikos@example.com" } },
  },
  {
    id: "search-en",
    language: "english",
    prompt: "What is the price of Brent crude oil today?",
    expect: { tool: "search_web", contains: { query: "brent" } },
  },
  {
    id: "search-el",
    language: "greek",
    prompt: "Ποια είναι η σημερινή τιμή του πετρελαίου Brent;",
    expect: { tool: "search_web", contains: { query: "brent" } },
  },
  {
    id: "calendar-en",
    language: "english",
    prompt:
      "Schedule a 30 minute call called 'Supplier review' on 2026-11-03 at 10:00.",
    expect: {
      tool: "create_calendar_event",
      contains: { title: "supplier review", start: "2026-11-03" },
      equals: { duration_minutes: 30 },
    },
  },
  {
    id: "file-en",
    language: "english",
    prompt: "Open the file notes/todo.txt and tell me what is in it.",
    expect: { tool: "read_file", equals: { path: "notes/todo.txt" } },
  },
  {
    id: "words-en",
    language: "english",
    prompt: "Say hello in one short sentence.",
    expect: null,
  },
  {
    id: "words-el",
    language: "greek",
    prompt: "Πες μου γεια με μία σύντομη πρόταση.",
    expect: null,
  },
  {
    id: "email-ar",
    language: "arabic",
    prompt:
      "أرسل بريدًا إلى omar@example.com وأخبره أن الفاتورة 2087 ستُدفع يوم الخميس.",
    expect: {
      tool: "send_email",
      contains: { to: "omar@example.com", body: "2087" },
    },
  },
  {
    id: "search-ar",
    language: "arabic",
    prompt: "ما هو سعر خام Brent اليوم؟",
    expect: { tool: "search_web", contains: { query: "brent" } },
  },
  {
    id: "words-ar",
    language: "arabic",
    prompt: "قل لي مرحبًا بجملة قصيرة واحدة.",
    expect: null,
  },
];

export type ToolCall = {
  function?: { name?: string; arguments?: string };
};

export type Message = {
  content?: string | null;
  tool_calls?: ToolCall[];
};

export type Verdict = { ok: boolean; why: string };

const GREEK = /[Ͱ-Ͽἀ-῿]/;
const ARABIC = /[\u0600-\u06FF]/;

/** Whether one answer is what the case wanted, and if not, the first thing wrong with it. */
export function judge(wanted: Case, message: Message): Verdict {
  const calls = message.tool_calls ?? [];
  if (wanted.expect === null) {
    if (calls.length > 0) {
      return {
        ok: false,
        why: `called ${calls[0]?.function?.name ?? "a tool"} when none was wanted`,
      };
    }
    const text = (message.content ?? "").trim();
    if (!text) return { ok: false, why: "no words and no tool" };
    if (wanted.language === "greek" && !GREEK.test(text)) {
      return { ok: false, why: "answered a Greek request without Greek" };
    }
    if (wanted.language === "arabic" && !ARABIC.test(text)) {
      return { ok: false, why: "answered an Arabic request without Arabic" };
    }
    return { ok: true, why: "answered in words" };
  }
  const call = calls[0];
  if (!call?.function?.name) {
    return { ok: false, why: "no tool call" };
  }
  if (call.function.name !== wanted.expect.tool) {
    return {
      ok: false,
      why: `called ${call.function.name}, wanted ${wanted.expect.tool}`,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments ?? "");
  } catch {
    return { ok: false, why: "arguments are not valid JSON" };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, why: "arguments are not an object" };
  }
  const tool = TOOLS.find((t) => t.function.name === wanted.expect?.tool);
  for (const name of tool?.function.parameters.required ?? []) {
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      return { ok: false, why: `missing required argument ${name}` };
    }
  }
  for (const [name, type] of Object.entries(
    tool?.function.parameters.properties ?? {},
  )) {
    const value = args[name];
    if (value === undefined) continue;
    const actual = Number.isInteger(value) ? "integer" : typeof value;
    if (type.type === "integer" ? actual !== "integer" : actual !== type.type) {
      return {
        ok: false,
        why: `argument ${name} is ${actual}, wanted ${type.type}`,
      };
    }
  }
  for (const [name, needle] of Object.entries(wanted.expect.contains ?? {})) {
    const sent = String(args[name] ?? "");
    if (!sent.toLowerCase().includes(needle.toLowerCase())) {
      // What the model sent, so a miss can be read: a search in the person's own script is not
      // the same failure as a search for the wrong thing.
      return {
        ok: false,
        why: `argument ${name} does not contain "${needle}" (sent ${JSON.stringify(sent.slice(0, 80))})`,
      };
    }
  }
  for (const [name, value] of Object.entries(wanted.expect.equals ?? {})) {
    if (args[name] !== value) {
      return {
        ok: false,
        why: `argument ${name} is ${JSON.stringify(args[name])}, wanted ${JSON.stringify(value)}`,
      };
    }
  }
  return { ok: true, why: "right tool, valid arguments" };
}

export type Attempt = {
  caseId: string;
  language: Case["language"];
  verdict: Verdict;
  seconds: number;
};

export async function attempt(
  options: {
    url: string;
    token?: string;
    model: string;
    timeoutSeconds: number;
    /** How many times a 429 is waited out before it counts as a failure. */
    rateLimitRetries?: number;
    wait?: (seconds: number) => Promise<void>;
  },
  wanted: Case,
): Promise<Attempt> {
  const retries = options.rateLimitRetries ?? 4;
  const wait =
    options.wait ??
    ((seconds: number) =>
      new Promise((done) => setTimeout(done, seconds * 1000)));
  // A free tier answers 429 when asked too fast, which says nothing about the model's tool calls
  // (desk #83: rounds 2 and 3 of Mercury 3 were all 429). So it is waited out, as the provider
  // asks in Retry-After; only the answered request is timed, so the wait is not the model's.
  for (let retry = 0; ; retry += 1) {
    const { retryAfter, ...result } = await once(options, wanted);
    if (result.verdict.why !== "HTTP 429" || retry >= retries) {
      return result;
    }
    const asked = Number(retryAfter);
    await wait(
      Math.min(
        60,
        Number.isFinite(asked) && asked > 0 ? asked : 5 * 2 ** retry,
      ),
    );
  }
}

async function once(
  options: {
    url: string;
    token?: string;
    model: string;
    timeoutSeconds: number;
  },
  wanted: Case,
): Promise<Attempt & { retryAfter?: string | null }> {
  const started = performance.now();
  const response = await fetch(`${options.url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.3,
      max_tokens: 400,
      tools: TOOLS,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant at a company. Use the tools you are given when a task needs them. Reply in the language the person writes in.",
        },
        { role: "user", content: wanted.prompt },
      ],
    }),
    signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
  });
  if (!response.ok) {
    return {
      caseId: wanted.id,
      language: wanted.language,
      verdict: { ok: false, why: `HTTP ${response.status}` },
      seconds: (performance.now() - started) / 1000,
      retryAfter: response.headers.get("retry-after"),
    };
  }
  const body = (await response.json()) as {
    choices?: { message?: Message }[];
  };
  const message = body.choices?.[0]?.message ?? {};
  return {
    caseId: wanted.id,
    language: wanted.language,
    verdict: judge(wanted, message),
    seconds: (performance.now() - started) / 1000,
  };
}

export type Summary = {
  total: number;
  passed: number;
  byLanguage: Record<string, { total: number; passed: number }>;
  failures: { caseId: string; why: string }[];
  averageSeconds: number;
};

export function summarise(attempts: Attempt[]): Summary {
  const byLanguage: Summary["byLanguage"] = {};
  const failures: Summary["failures"] = [];
  let passed = 0;
  let seconds = 0;
  for (const item of attempts) {
    const row = byLanguage[item.language] ?? { total: 0, passed: 0 };
    byLanguage[item.language] = row;
    row.total += 1;
    seconds += item.seconds;
    if (item.verdict.ok) {
      row.passed += 1;
      passed += 1;
    } else {
      failures.push({ caseId: item.caseId, why: item.verdict.why });
    }
  }
  return {
    total: attempts.length,
    passed,
    byLanguage,
    failures,
    averageSeconds: attempts.length ? seconds / attempts.length : 0,
  };
}

export function render(summary: Summary): string {
  const lines = [
    `Passed ${summary.passed} of ${summary.total} (${summary.total ? Math.round((100 * summary.passed) / summary.total) : 0}%), ${summary.averageSeconds.toFixed(1)} s each on average.`,
  ];
  for (const [language, row] of Object.entries(summary.byLanguage)) {
    lines.push(`  ${language}: ${row.passed} of ${row.total}`);
  }
  if (summary.failures.length > 0) {
    lines.push("Failures:");
    const counts = new Map<string, number>();
    for (const failure of summary.failures) {
      const key = `${failure.caseId}: ${failure.why}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) lines.push(`  ${count}x ${key}`);
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag?.startsWith("--") && next !== undefined) {
      values.set(flag.slice(2), next);
      i += 1;
    }
  }
  const url = values.get("url");
  if (!url) throw new Error("Give --url, like http://127.0.0.1:8080/v1");
  // `--token-env NAME` reads the key from that variable, so a hosted provider's key is never typed
  // on a command line, where it would stay in the shell's history and show in the process list.
  const tokenEnv = values.get("token-env");
  if (tokenEnv && !process.env[tokenEnv]?.trim()) {
    throw new Error(`--token-env names ${tokenEnv}, which is not set.`);
  }
  const options = {
    url: url.replace(/\/+$/, ""),
    token: tokenEnv ? process.env[tokenEnv]?.trim() : values.get("token"),
    model: values.get("model") ?? "gemma-4-e4b",
    timeoutSeconds: Number(values.get("timeout") ?? 300),
  };
  const repeats = Number(values.get("repeats") ?? 3);
  const attempts: Attempt[] = [];
  for (let round = 0; round < repeats; round += 1) {
    for (const wanted of CASES) {
      const result = await attempt(options, wanted).catch(
        (error): Attempt => ({
          caseId: wanted.id,
          language: wanted.language,
          verdict: {
            ok: false,
            why: `request failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          seconds: 0,
        }),
      );
      attempts.push(result);
      console.error(
        `${result.verdict.ok ? "ok  " : "FAIL"} ${wanted.id} (${result.seconds.toFixed(1)} s) ${result.verdict.ok ? "" : result.verdict.why}`,
      );
    }
  }
  const summary = summarise(attempts);
  console.log(render(summary));
  if (attempts.every((item) => item.verdict.why.startsWith("request failed"))) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
