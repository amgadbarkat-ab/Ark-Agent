/**
 * Scoring an employee's standing instruction against its test cases (#116).
 *
 * PER CASE. The employee model gets the instruction and the made-up question, with the employee's
 * tools offered and every call answered by the case's fixed sample (nothing runs). Then a judge call
 * on the same endpoint says, item by item, whether the answer does what it must and avoids what it
 * must not, and plain code checks the rules. The case passes only if all of that holds.
 *
 * THE GATE. A proposed instruction is blocked when it scores lower than the current one, or when it
 * fails a rule on a case where the current one did not. A written reason lets it through, and that
 * reason goes into the report and the new draft profile's notes.
 */
import { listTools as boxnowTools } from "../../server/src/plugins/boxnow";
import { listTools as businessFileTools } from "../../server/src/plugins/business-files";
import { listTools as eltaTools } from "../../server/src/plugins/elta";
import { listTools as mailboxTools } from "../../server/src/plugins/mailbox";
import type { McpTool } from "../../server/src/plugins/mcp";
import { listTools as priceListTools } from "../../server/src/plugins/price-list";
import { listTools as priceWatchTools } from "../../server/src/plugins/price-watch";
import { listTools as skroutzTools } from "../../server/src/plugins/skroutz";
import { listTools as wooTools } from "../../server/src/plugins/woocommerce";
import type {
  RosterConnector,
  RosterEntry,
  TrialProfile,
  TrialTestCase,
} from "../../shared/trial";
import type { ProposedChange } from "../../shared/trial-change";
import {
  ArkEvalError,
  type ChatClient,
  type ChatMessage,
  jsonFrom,
  type ToolSpec,
} from "./model";
import { checkRules, type RuleFailure, type ToolUse } from "./rules";

export type Verdict = {
  kind: "must" | "mustNot";
  item: string;
  ok: boolean;
  why: string;
};

export type CaseResult = {
  id: string;
  ask: string;
  answer: string;
  toolUses: ToolUse[];
  verdicts: Verdict[];
  ruleFailures: RuleFailure[];
  passed: boolean;
};

export type EmployeeScore = {
  key: string;
  name: string;
  instructions: string;
  cases: CaseResult[];
  passed: number;
  total: number;
};

export type Models = { answer: string; judge: string };

/** Said back to every tool call in a test unless the case gives its own sample. */
export const DRY_RUN_ANSWER =
  "This is a test: the call was recorded, and nothing was looked up, saved or sent.";
/** Tool rounds per answer before the employee's last words count as its answer. */
const MAX_TOOL_ROUNDS = 4;

const CONNECTOR_TOOLS: Record<RosterConnector, () => Promise<McpTool[]>> = {
  skroutz: skroutzTools,
  woocommerce: wooTools,
  boxnow: boxnowTools,
  elta: eltaTools,
  "business-files": businessFileTools,
  "price-watch": priceWatchTools,
};

/** The tools the employee has in the app, with the app's own descriptions. Never run here. */
export async function employeeTools(entry: RosterEntry): Promise<ToolSpec[]> {
  const lists: McpTool[][] = [];
  if (entry.mail) lists.push(await mailboxTools());
  if (entry.priceList) lists.push(await priceListTools());
  for (const connector of entry.connectors ?? []) {
    lists.push(await CONNECTOR_TOOLS[connector]());
  }
  const seen = new Set<string>();
  const specs: ToolSpec[] = [];
  for (const tool of lists.flat()) {
    // Two connectors can share a name (get_order); the first is enough for a test.
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    specs.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: (tool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      },
    });
  }
  return specs;
}

/**
 * What the employee model is told: who it is and the standing instruction. Not the customer's name:
 * only our own instruction text leaves this computer, and it says what it needs to.
 */
export function employeePrompt(
  entry: RosterEntry,
  instructions: string,
): string {
  return [
    `You are ${entry.name}, ${entry.title}, a digital employee of the business.`,
    `Your role: ${entry.roleDescription}`,
    "",
    "Your standing instruction:",
    instructions,
  ].join("\n");
}

async function answerCase(
  client: ChatClient,
  model: string,
  system: string,
  testCase: TrialTestCase,
  tools: ToolSpec[],
): Promise<{ answer: string; toolUses: ToolUse[] }> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: testCase.ask },
  ];
  const toolUses: ToolUse[] = [];
  for (let round = 0; ; round++) {
    const reply = await client.chat({ model, messages, tools });
    if (reply.toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) {
      return { answer: reply.content.trim(), toolUses };
    }
    messages.push({
      role: "assistant",
      content: reply.content || null,
      tool_calls: reply.toolCalls,
    });
    for (const call of reply.toolCalls) {
      const name = call.function?.name ?? "";
      toolUses.push({ name, arguments: call.function?.arguments ?? "" });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: testCase.toolAnswers?.[name] ?? DRY_RUN_ANSWER,
      });
    }
  }
}

const JUDGE_SYSTEM = [
  "You grade one answer from a business's digital employee against a checklist.",
  'Items whose id starts with "M" are things the answer MUST do: ok is true only if the answer clearly does it.',
  'Items whose id starts with "N" are things the answer must NOT do: ok is true only if the answer does not do it.',
  "Tool calls the employee made count as part of what it did.",
  "Judge only what is written. Be strict: when unsure, ok is false.",
  'Reply with one JSON object and nothing else: {"verdicts":[{"id":"M1","ok":true,"why":"one short sentence"}]}, one entry per item.',
].join("\n");

async function judgeCase(
  client: ChatClient,
  model: string,
  testCase: TrialTestCase,
  answer: string,
  toolUses: ToolUse[],
): Promise<Verdict[]> {
  const items = [
    ...testCase.must.map((item, index) => ({
      id: `M${index + 1}`,
      kind: "must" as const,
      item,
    })),
    ...testCase.mustNot.map((item, index) => ({
      id: `N${index + 1}`,
      kind: "mustNot" as const,
      item,
    })),
  ];
  const payload = JSON.stringify({
    question: testCase.ask,
    answer,
    toolCalls: toolUses,
    checklist: items.map(({ id, item }) => ({ id, item })),
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await client.chat({
      model,
      json: true,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: payload },
      ],
    });
    const parsed = jsonFrom(reply.content) as
      | { verdicts?: { id?: unknown; ok?: unknown; why?: unknown }[] }
      | undefined;
    const given = new Map(
      (Array.isArray(parsed?.verdicts) ? parsed.verdicts : [])
        .filter((verdict) => typeof verdict?.id === "string")
        .map((verdict) => [String(verdict.id).toUpperCase(), verdict]),
    );
    if (items.every(({ id }) => typeof given.get(id)?.ok === "boolean")) {
      return items.map(({ id, kind, item }) => {
        const verdict = given.get(id);
        return {
          kind,
          item,
          ok: verdict?.ok === true,
          why:
            typeof verdict?.why === "string" ? verdict.why.slice(0, 300) : "",
        };
      });
    }
  }
  // An unreadable judge fails the case rather than passing it.
  return items.map(({ kind, item }) => ({
    kind,
    item,
    ok: false,
    why: "the judge gave no readable verdict",
  }));
}

/** Every case of one employee, with one instruction text. */
export async function scoreEmployee(input: {
  client: ChatClient;
  models: Models;
  profile: TrialProfile;
  entry: RosterEntry;
  instructions: string;
  /** One line per case as it finishes, for a person watching. */
  progress?: (line: string) => void;
}): Promise<EmployeeScore> {
  const cases = input.entry.tests ?? [];
  if (cases.length === 0) {
    throw new ArkEvalError(
      `${input.entry.key} has no test cases in the profile, so nothing can be scored.`,
    );
  }
  const tools = await employeeTools(input.entry);
  const system = employeePrompt(input.entry, input.instructions);
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const { answer, toolUses } = await answerCase(
      input.client,
      input.models.answer,
      system,
      testCase,
      tools,
    );
    const verdicts = await judgeCase(
      input.client,
      input.models.judge,
      testCase,
      answer,
      toolUses,
    );
    const ruleFailures = checkRules({
      rules: testCase.rules,
      amkaAlways: input.profile.mailBlockAmka === true,
      answer,
      toolUses,
    });
    const passed =
      verdicts.every((verdict) => verdict.ok) && ruleFailures.length === 0;
    results.push({
      id: testCase.id,
      ask: testCase.ask,
      answer,
      toolUses,
      verdicts,
      ruleFailures,
      passed,
    });
    input.progress?.(
      `  ${input.entry.key}/${testCase.id}: ${passed ? "pass" : "FAIL"}`,
    );
  }
  return {
    key: input.entry.key,
    name: input.entry.name,
    instructions: input.instructions,
    cases: results,
    passed: results.filter((result) => result.passed).length,
    total: results.length,
  };
}

export type NewRuleFailure = { caseId: string; failure: RuleFailure };

export type Comparison = {
  before: EmployeeScore;
  after: EmployeeScore;
  scoreDropped: boolean;
  newRuleFailures: NewRuleFailure[];
  blocked: boolean;
};

function ruleKey(failure: RuleFailure): string {
  // A tools failure is about one tool; the others are one per kind, whatever the amount or word.
  return failure.rule === "tools" ? `tools:${failure.detail}` : failure.rule;
}

export function compareScores(
  before: EmployeeScore,
  after: EmployeeScore,
): Comparison {
  const newRuleFailures: NewRuleFailure[] = [];
  for (const result of after.cases) {
    const had = new Set(
      (
        before.cases.find((old) => old.id === result.id)?.ruleFailures ?? []
      ).map(ruleKey),
    );
    for (const failure of result.ruleFailures) {
      if (!had.has(ruleKey(failure))) {
        newRuleFailures.push({ caseId: result.id, failure });
      }
    }
  }
  const scoreDropped =
    after.passed / after.total < before.passed / before.total;
  return {
    before,
    after,
    scoreDropped,
    newRuleFailures,
    blocked: scoreDropped || newRuleFailures.length > 0,
  };
}

/** Strictly better: what `tune` needs before it offers a proposal to a person. */
export function beats(comparison: Comparison): boolean {
  return (
    !comparison.blocked &&
    comparison.after.passed / comparison.after.total >
      comparison.before.passed / comparison.before.total
  );
}

// ---- the report --------------------------------------------------------------------------------

export function scoreText(score: EmployeeScore): string {
  const percent = Math.round((score.passed / score.total) * 100);
  return `${score.passed}/${score.total} (${percent}%)`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function caseCell(result: CaseResult | undefined): string {
  if (!result) return "";
  if (result.passed) return "pass";
  const reasons = [
    ...result.verdicts
      .filter((verdict) => !verdict.ok)
      .map((verdict) =>
        verdict.kind === "must"
          ? `did not: ${verdict.item}`
          : `did: ${verdict.item}`,
      ),
    ...result.ruleFailures.map(
      (failure) => `rule ${failure.rule}: ${failure.detail}`,
    ),
  ];
  return `**FAIL**: ${cell(reasons.join("; "))}`;
}

/** A plain line diff (longest common subsequence), enough for a person to see what changed. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lengths[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((lengths[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (lengths[i + 1] as number[])[j] as number,
              row[j + 1] as number,
            );
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (
      ((lengths[i + 1] as number[])[j] as number) >=
      ((lengths[i] as number[])[j + 1] as number)
    ) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) lines.push(`- ${a[i++]}`);
  while (j < b.length) lines.push(`+ ${b[j++]}`);
  return lines.join("\n");
}

function caseDetails(label: string, result: CaseResult): string[] {
  const lines = [
    `**${label}** (${result.passed ? "pass" : "fail"})`,
    "",
    `> ${result.answer.slice(0, 1500).replace(/\n/g, "\n> ") || "(no answer)"}`,
    "",
  ];
  if (result.toolUses.length > 0) {
    lines.push(
      `Tools called: ${result.toolUses.map((use) => `\`${use.name}\``).join(", ")}`,
      "",
    );
  }
  for (const verdict of result.verdicts) {
    lines.push(
      `- ${verdict.ok ? "ok" : "NOT OK"}, ${verdict.kind === "must" ? "must" : "must not"}: ${verdict.item}${verdict.why ? ` (${verdict.why})` : ""}`,
    );
  }
  for (const failure of result.ruleFailures) {
    lines.push(`- RULE ${failure.rule}: ${failure.detail}`);
  }
  lines.push("");
  return lines;
}

export type Decision =
  | { kind: "none" }
  | { kind: "passed" }
  | { kind: "blocked" }
  | { kind: "overridden"; reason: string };

export function decide(
  comparison: Comparison | undefined,
  reason: string | undefined,
): Decision {
  if (!comparison) return { kind: "none" };
  if (!comparison.blocked) return { kind: "passed" };
  return reason ? { kind: "overridden", reason } : { kind: "blocked" };
}

function blockedBecause(comparison: Comparison): string[] {
  const why: string[] = [];
  if (comparison.scoreDropped) {
    why.push(
      `it scores lower: ${scoreText(comparison.before)} before, ${scoreText(comparison.after)} after`,
    );
  }
  for (const { caseId, failure } of comparison.newRuleFailures) {
    why.push(
      `it adds a rule failure on \`${caseId}\`: ${failure.rule}, ${failure.detail}`,
    );
  }
  return why;
}

export function buildReport(input: {
  profile: TrialProfile;
  endpointLabel: string;
  models: Models;
  when: Date;
  /** Without a proposed change: the current score of each employee run. */
  current: EmployeeScore[];
  change?: ProposedChange;
  comparison?: Comparison;
  decision: Decision;
  /** Where the new draft profile was written, when one was. */
  draftPath?: string;
}): string {
  const out: string[] = [
    `# ArkAgent evaluation: ${input.profile.customer.name}`,
    "",
    `- Profile: \`${input.profile.customer.id}\`, issued ${input.profile.issuedAt}`,
    `- Run: ${input.when.toISOString()}`,
    `- Answers: \`${input.models.answer}\`; judge: \`${input.models.judge}\`; on ${input.endpointLabel}`,
    "- Sent to the model: the made-up test questions and our own instruction text only.",
    "- The scores come from this model, not from the model on the customer's computer. They say whether an instruction got better or worse; spot-check two or three cases on a trial computer after each signed change.",
    "",
  ];
  const { comparison, change } = input;
  if (comparison && change) {
    out.push(
      `## ${comparison.before.name} (\`${comparison.before.key}\`)`,
      "",
      `**Before:** ${scoreText(comparison.before)} · **After:** ${scoreText(comparison.after)} · rule failures ${count(comparison.before)} → ${count(comparison.after)}`,
      "",
      "| Case | Before | After |",
      "|---|---|---|",
      ...comparison.before.cases.map(
        (result) =>
          `| \`${result.id}\` | ${caseCell(result)} | ${caseCell(comparison.after.cases.find((other) => other.id === result.id))} |`,
      ),
      "",
      "### The change",
      "",
      ...(change.summary ? [change.summary, ""] : []),
      "```diff",
      lineDiff(comparison.before.instructions, comparison.after.instructions),
      "```",
      "",
      "## Decision",
      "",
    );
    const decision = input.decision;
    if (decision.kind === "passed") {
      out.push(
        "**Passed.** The proposed instruction scores at least as well as the current one and adds no rule failure.",
      );
    } else if (decision.kind === "blocked") {
      out.push(
        "**BLOCKED.** The change does not go on, because:",
        "",
        ...blockedBecause(comparison).map((line) => `- ${line}`),
        "",
        'To send it on anyway, run again with `--reason "<why>"`. The reason is printed here and recorded in the new profile\'s notes.',
      );
    } else if (decision.kind === "overridden") {
      out.push(
        "**Overridden with a written reason.** It would have been blocked, because:",
        "",
        ...blockedBecause(comparison).map((line) => `- ${line}`),
        "",
        `Reason given: "${decision.reason}"`,
      );
    }
    if (input.draftPath) {
      out.push(
        "",
        "## Next step",
        "",
        `New draft profile: \`${input.draftPath}\` (not signed). A person reads this report; then BlackArk signs it with \`bun scripts/ark-trial.ts sign-profile ${input.draftPath}\`.`,
      );
    }
    out.push("", "## Answers, case by case", "");
    for (const result of comparison.before.cases) {
      out.push(`### \`${result.id}\``, "", `Question: ${result.ask}`, "");
      out.push(...caseDetails("Before", result));
      const after = comparison.after.cases.find(
        (other) => other.id === result.id,
      );
      if (after) out.push(...caseDetails("After", after));
    }
  } else {
    for (const score of input.current) {
      out.push(
        `## ${score.name} (\`${score.key}\`)`,
        "",
        `**Score:** ${scoreText(score)} · rule failures ${count(score)}`,
        "",
        "| Case | Result |",
        "|---|---|",
        ...score.cases.map(
          (result) => `| \`${result.id}\` | ${caseCell(result)} |`,
        ),
        "",
      );
      for (const result of score.cases) {
        out.push(`### \`${result.id}\``, "", `Question: ${result.ask}`, "");
        out.push(...caseDetails("Answer", result));
      }
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function count(score: EmployeeScore): number {
  return score.cases.reduce(
    (total, result) => total + result.ruleFailures.length,
    0,
  );
}

/**
 * The profile as a new, unsigned draft: the employee's instruction replaced and a note added. No
 * issuedAt, so `sign-profile` stamps it now and the signed file replaces the older one on import.
 */
export function draftWithChange(
  profile: TrialProfile,
  change: ProposedChange,
  note: string,
): Record<string, unknown> {
  const { issuedAt: _issuedAt, ...rest } = profile;
  return {
    ...rest,
    roster: profile.roster.map((entry) =>
      entry.key === change.employee
        ? { ...entry, instructions: change.instructions }
        : entry,
    ),
    notes: [...(profile.notes ?? []), note],
  };
}

export function changeNote(
  comparison: Comparison,
  decision: Decision,
  when: Date,
  change: ProposedChange,
): string {
  const base = `${when.toISOString().slice(0, 10)} ${comparison.before.key}: standing instruction changed${change.source ? ` (${change.source === "tune" ? "an approved tune proposal" : "a person's request"})` : ""}, scored ${scoreText(comparison.before)} before and ${scoreText(comparison.after)} after (ark-eval, #116).`;
  return decision.kind === "overridden"
    ? `${base} It would have been blocked; sent on with the written reason: ${decision.reason}`
    : base;
}
