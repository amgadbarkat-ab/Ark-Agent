#!/usr/bin/env bun
/**
 * Scoring trial employees' standing instructions against their test cases (#116). Run on Amgad's
 * computer only, with one of BlackArk's free keys (Groq, or Cerebras).
 *
 *   bun scripts/ark-eval.ts run --profile <profile.json | customer.arktrial> [--employee <key>]
 *       [--proposed <change.json>] [--reason "<text>"] [--report <file.md>] [--out <draft.json>]
 *       [--provider groq|cerebras] [--model <id>] [--judge-model <id>]
 *     Runs every test case of the employee(s) with the CURRENT instruction and, with --proposed, the
 *     PROPOSED one, and prints a Markdown report (also written to a file). A change that scores lower
 *     or adds a rule failure is BLOCKED (exit code 2) unless --reason is given. A change that goes on
 *     is written as a new, UNSIGNED draft profile with a note (and the reason) in its `notes`; BlackArk
 *     signs it with `bun scripts/ark-trial.ts sign-profile` as today.
 *
 *   bun scripts/ark-eval.ts tune --profile <p> --employee <key> [--rounds 3] [--out-dir <dir>]
 *       [--provider groq|cerebras] [--model <id>] [--judge-model <id>] [--proposer-model <id>]
 *     Needs Amgad's yes for the proposer. A proposer model suggests a better instruction; one that
 *     beats the current version is shown, and written as a proposed-change file only after a person
 *     answers y. It never edits or signs a profile.
 *
 * THE KEY comes only from ARK_EVAL_API_KEY or a masked prompt. Never from the command line, never
 * printed, never written to a file. Only the made-up test questions and our own instruction text
 * are sent. Never the local model, never an Anthropic key, never DeepSeek.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  PROFILE_FORMAT,
  readProfile,
  readProfileFile,
  type TrialProfile,
} from "../shared/trial";
import {
  type ProposedChange,
  readProposedChange,
} from "../shared/trial-change";
import {
  buildReport,
  type Comparison,
  changeNote,
  compareScores,
  decide,
  draftWithChange,
  type EmployeeScore,
  type Models,
  scoreEmployee,
  scoreText,
} from "./eval/evaluate";
import {
  ArkEvalError,
  makeClient,
  PROVIDERS,
  type ProviderId,
  redact,
} from "./eval/model";
import { TUNE_NOTICE, tune } from "./eval/tune";

export const KEY_VARIABLE = "ARK_EVAL_API_KEY";
const MAX_REASON = 1500;

export type Deps = {
  env: Record<string, string | undefined>;
  cwd: string;
  /** Standard output: the report. */
  out: (text: string) => void;
  /** Standard error: progress and messages. */
  err: (text: string) => void;
  /** A masked prompt for the key; absent when there is no terminal. */
  readKey?: () => Promise<string>;
  /** A y/n question to a person; absent when there is no terminal. */
  ask?: (question: string) => Promise<string>;
  /** Tests only: a stand-in endpoint. The command line cannot set this. */
  endpoint?: { baseUrl: string; label: string };
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const USAGE = [
  "Use:",
  '  bun scripts/ark-eval.ts run --profile <profile.json|.arktrial> [--employee <key>] [--proposed <change.json>] [--reason "<text>"] [--report <file.md>] [--out <draft.json>]',
  "  bun scripts/ark-eval.ts tune --profile <profile> --employee <key> [--rounds 3] [--out-dir <dir>]",
  "Both take [--provider groq|cerebras] [--model <id>] [--judge-model <id>]; tune also [--proposer-model <id>].",
  `The key comes from ${KEY_VARIABLE} or a masked prompt, never from the command line.`,
].join("\n");

const VALUE_OPTIONS = {
  run: [
    "--profile",
    "--employee",
    "--proposed",
    "--reason",
    "--report",
    "--out",
    "--provider",
    "--model",
    "--judge-model",
  ],
  tune: [
    "--profile",
    "--employee",
    "--rounds",
    "--out-dir",
    "--provider",
    "--model",
    "--judge-model",
    "--proposer-model",
  ],
} as const;

function parseOptions(
  command: keyof typeof VALUE_OPTIONS,
  args: string[],
): Map<string, string> {
  const known: readonly string[] = VALUE_OPTIONS[command];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index] as string;
    if (/^--(api-?)?key$|^--token$/.test(name)) {
      throw new ArkEvalError(
        `The key is never taken from the command line. Set ${KEY_VARIABLE}, or type it at the prompt.`,
      );
    }
    if (!known.includes(name)) {
      throw new ArkEvalError(`${command} does not take ${name}.\n${USAGE}`);
    }
    const value = args[index + 1];
    if (
      value === undefined ||
      (value.startsWith("--") && name !== "--reason")
    ) {
      throw new ArkEvalError(`${name} needs a value.`);
    }
    options.set(name, value);
    index++;
  }
  return options;
}

function loadProfile(path: string, now: Date): TrialProfile {
  if (!existsSync(path)) throw new ArkEvalError(`There is no file at ${path}.`);
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArkEvalError(`${path} is not JSON.`);
  }
  if ((raw as { format?: unknown })?.format === PROFILE_FORMAT) {
    return readProfileFile(text).profile;
  }
  // A draft, as sign-profile reads it: no issuedAt yet is fine.
  const draft = { ...(raw as Record<string, unknown>) };
  draft.issuedAt ??= now.toISOString();
  return readProfile(draft);
}

function stamp(when: Date): string {
  return when
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
}

async function apiKey(deps: Deps): Promise<string> {
  const fromEnv = deps.env[KEY_VARIABLE]?.trim();
  if (fromEnv) return fromEnv;
  if (!deps.readKey) {
    throw new ArkEvalError(
      `No key. Set ${KEY_VARIABLE} to BlackArk's free Groq or Cerebras key, or run this in a terminal to type it.`,
    );
  }
  const typed = (await deps.readKey()).trim();
  if (!typed) throw new ArkEvalError("No key was typed.");
  return typed;
}

async function setUp(options: Map<string, string>, deps: Deps) {
  const providerId = options.get("--provider") ?? "groq";
  if (!Object.hasOwn(PROVIDERS, providerId)) {
    throw new ArkEvalError(
      "--provider is groq or cerebras. ark-eval uses only these free keys (#116).",
    );
  }
  const provider = PROVIDERS[providerId as ProviderId];
  const model =
    options.get("--model") ?? deps.env.ARK_EVAL_MODEL ?? provider.defaultModel;
  const models: Models & { proposer: string } = {
    answer: model,
    judge: options.get("--judge-model") ?? model,
    proposer: options.get("--proposer-model") ?? model,
  };
  const now = deps.now ?? (() => new Date());
  const profilePath = options.get("--profile");
  if (!profilePath) throw new ArkEvalError(`Give --profile.\n${USAGE}`);
  const profile = loadProfile(resolve(deps.cwd, profilePath), now());
  return { provider, models, now, profile, profilePath };
}

async function client(deps: Deps, label: string, baseUrl: string) {
  const key = await apiKey(deps);
  const endpoint = deps.endpoint ?? { baseUrl, label };
  return {
    key,
    client: makeClient({
      baseUrl: endpoint.baseUrl,
      label: endpoint.label,
      apiKey: key,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    }),
  };
}

async function runCommand(args: string[], deps: Deps): Promise<number> {
  const options = parseOptions("run", args);
  const { provider, models, now, profile, profilePath } = await setUp(
    options,
    deps,
  );
  const reasonRaw = options.get("--reason");
  const reason = reasonRaw?.replace(/\s+/g, " ").trim();
  if (reasonRaw !== undefined && !reason) {
    throw new ArkEvalError("--reason needs the reason written out.");
  }
  if (reason && reason.length > MAX_REASON) {
    throw new ArkEvalError(`--reason is at most ${MAX_REASON} characters.`);
  }
  const proposedPath = options.get("--proposed");
  if (reason && !proposedPath) {
    throw new ArkEvalError("--reason only goes with --proposed.");
  }
  let change: ProposedChange | undefined;
  if (proposedPath) {
    const path = resolve(deps.cwd, proposedPath);
    if (!existsSync(path))
      throw new ArkEvalError(`There is no file at ${path}.`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new ArkEvalError(`${path} is not JSON.`);
    }
    change = readProposedChange(raw, profile);
  }
  const only = change?.employee ?? options.get("--employee");
  const entries = profile.roster.filter((entry) =>
    only ? entry.key === only : (entry.tests?.length ?? 0) > 0,
  );
  if (only && entries.length === 0) {
    throw new ArkEvalError(`There is no employee "${only}" in the profile.`);
  }
  if (entries.length === 0) {
    throw new ArkEvalError("No employee in this profile has test cases.");
  }
  const { client: chat } = await client(deps, provider.name, provider.baseUrl);
  const progress = (line: string) => deps.err(`${line}\n`);
  const when = now();
  const current: EmployeeScore[] = [];
  let comparison: Comparison | undefined;
  for (const entry of entries) {
    progress(`${entry.key}: current instruction`);
    const before = await scoreEmployee({
      client: chat,
      models,
      profile,
      entry,
      instructions: entry.instructions,
      progress,
    });
    current.push(before);
    if (change) {
      progress(`${entry.key}: proposed instruction`);
      const after = await scoreEmployee({
        client: chat,
        models,
        profile,
        entry,
        instructions: change.instructions,
        progress,
      });
      comparison = compareScores(before, after);
    }
  }
  const decision = decide(comparison, reason);
  // Written next to the profile unless told otherwise, where the person signing will look.
  const beside = (name: string) =>
    join(dirname(resolve(deps.cwd, profilePath)), name);
  let draftPath: string | undefined;
  if (change && comparison && decision.kind !== "blocked") {
    draftPath = resolve(
      deps.cwd,
      options.get("--out") ??
        beside(`${profile.customer.id}-draft-${stamp(when)}.json`),
    );
    const draft = draftWithChange(
      profile,
      change,
      changeNote(comparison, decision, when, change),
    );
    // Checked as sign-profile will check it, so a draft that would be refused is never handed on.
    readProfile({ ...draft, issuedAt: when.toISOString() });
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, {
      flag: "wx",
    });
  }
  const report = buildReport({
    profile,
    endpointLabel: chat.label,
    models,
    when,
    current,
    ...(change ? { change } : {}),
    ...(comparison ? { comparison } : {}),
    decision,
    ...(draftPath ? { draftPath } : {}),
  });
  const reportPath = resolve(
    deps.cwd,
    options.get("--report") ??
      beside(`${profile.customer.id}-eval-${stamp(when)}.md`),
  );
  writeFileSync(reportPath, report);
  deps.out(report);
  if (comparison) {
    deps.err(
      `${scoreText(comparison.before)} before, ${scoreText(comparison.after)} after: ${decision.kind.toUpperCase()}.\n`,
    );
  }
  deps.err(`Report written to ${reportPath}\n`);
  if (draftPath) deps.err(`Unsigned draft profile written to ${draftPath}\n`);
  return decision.kind === "blocked" ? 2 : 0;
}

async function tuneCommand(args: string[], deps: Deps): Promise<number> {
  const options = parseOptions("tune", args);
  deps.err(`${TUNE_NOTICE}\n\n`);
  const ask = deps.ask;
  if (!ask) {
    throw new ArkEvalError(
      "tune asks a person to approve each proposal, so it runs only in a terminal.",
    );
  }
  const yes = async (question: string) =>
    /^y(es)?$/i.test((await ask(question)).trim());
  if (
    !(await yes("Has Amgad said yes to using the proposer for this? (y/N) "))
  ) {
    deps.err("Stopped. Nothing was sent and nothing was written.\n");
    return 1;
  }
  const { provider, models, now, profile, profilePath } = await setUp(
    options,
    deps,
  );
  const key = options.get("--employee");
  if (!key) throw new ArkEvalError(`tune needs --employee <key>.\n${USAGE}`);
  const entry = profile.roster.find((one) => one.key === key);
  if (!entry)
    throw new ArkEvalError(`There is no employee "${key}" in the profile.`);
  if (!entry.tests?.length) {
    throw new ArkEvalError(`${key} has no test cases in the profile.`);
  }
  const rounds = Number(options.get("--rounds") ?? "3");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
    throw new ArkEvalError("--rounds is a whole number from 1 to 20.");
  }
  const outDir = resolve(
    deps.cwd,
    options.get("--out-dir") ?? dirname(resolve(deps.cwd, profilePath)),
  );
  if (!existsSync(outDir))
    throw new ArkEvalError(`There is no folder ${outDir}.`);
  const { client: chat } = await client(deps, provider.name, provider.baseUrl);
  const { written } = await tune({
    client: chat,
    models,
    profile,
    entry,
    rounds,
    outDir,
    confirm: yes,
    print: (text) => deps.out(`${text}\n`),
    progress: (line) => deps.err(`${line}\n`),
    now,
  });
  deps.err(
    written.length > 0
      ? `${written.length} proposal(s) written. Score each with run --proposed before anything is signed.\n`
      : "No proposal was written.\n",
  );
  return 0;
}

export async function main(args: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = args;
  // The key is read inside; whatever escapes as an error is hidden from it before it is shown.
  let key = deps.env[KEY_VARIABLE]?.trim() ?? "";
  const readKey = deps.readKey;
  const tracked: Deps = {
    ...deps,
    ...(readKey
      ? {
          readKey: async () => {
            key = await readKey();
            return key;
          },
        }
      : {}),
    out: (text) => deps.out(redact(text, key)),
    err: (text) => deps.err(redact(text, key)),
  };
  try {
    if (command === "run") return await runCommand(rest, tracked);
    if (command === "tune") return await tuneCommand(rest, tracked);
    tracked.err(`${USAGE}\n`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tracked.err(`${message}\n`);
    return 1;
  }
}

/** Reads a line from the terminal without showing it: one * per character. */
function maskedPrompt(question: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const input = process.stdin;
    process.stderr.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let typed = "";
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolvePromise(typed);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new ArkEvalError("Cancelled."));
        if (char === "\u007f" || char === "\b") {
          if (typed.length > 0) {
            typed = typed.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else if (char >= " ") {
          typed += char;
          process.stderr.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

async function terminalQuestion(question: string): Promise<string> {
  const lines = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

if (import.meta.main) {
  const terminal = process.stdin.isTTY === true;
  const code = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    ...(terminal
      ? {
          readKey: () =>
            maskedPrompt(
              `${KEY_VARIABLE} is not set. Paste the free Groq or Cerebras key (hidden): `,
            ),
          ask: terminalQuestion,
        }
      : {}),
  });
  process.exit(code);
}
