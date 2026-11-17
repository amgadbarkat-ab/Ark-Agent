/**
 * `ark-eval tune` (#116, item 3): a cheap proposer model suggests a better standing instruction for
 * one employee, each suggestion is scored with the same cases and judge as `run`, and only one that
 * beats the current version is shown to a person.
 *
 * NOTHING IS WRITTEN WITHOUT A PERSON'S YES. Each proposal that beats the current version waits on a
 * y/n prompt; only a "y" writes it, and only as a proposed-change file. This never edits or signs a
 * profile: the change file goes through `run --proposed`, a person, and `sign-profile` like any other.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RosterEntry, TrialProfile } from "../../shared/trial";
import { CHANGE_FORMAT, type ProposedChange } from "../../shared/trial-change";
import {
  beats,
  compareScores,
  type EmployeeScore,
  employeeTools,
  lineDiff,
  type Models,
  scoreEmployee,
  scoreText,
} from "./evaluate";
import { type ChatClient, jsonFrom } from "./model";

export const TUNE_NOTICE = [
  "ark-eval tune sends the made-up test questions and our own instruction text to a proposer model on the free key.",
  "USING IT NEEDS AMGAD'S YES FOR THE PROPOSER (#116). Without that yes, stop here.",
  "Each proposal that beats the current instruction is shown to you, and is written to a proposed-change file only if you answer y.",
  "It never edits or signs a profile: signing stays BlackArk's manual sign-profile step.",
].join("\n");

const PROPOSER_SYSTEM = [
  "You improve the standing instruction of a business's digital employee, so that it passes more of its test cases.",
  "You get the current instruction, the employee's tools, and each test case with whether it passed and why not.",
  "Keep everything that already works. Change as little as needed. Write in the language the current instruction uses.",
  "Never add facts that are not already in the instruction: no prices, names, phone numbers, addresses or opening hours.",
  "What the employee should know about using a tool goes in the instruction too.",
  'Reply with one JSON object and nothing else: {"instructions":"<the whole new instruction>","summary":"<one or two sentences: what you changed and why>"}.',
].join("\n");

type Proposal = { instructions: string; summary: string };

async function propose(
  client: ChatClient,
  model: string,
  entry: RosterEntry,
  current: EmployeeScore,
): Promise<Proposal | undefined> {
  const tools = await employeeTools(entry);
  const reply = await client.chat({
    model,
    json: true,
    messages: [
      { role: "system", content: PROPOSER_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          role: `${entry.title}: ${entry.roleDescription}`,
          currentInstruction: current.instructions,
          tools: tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
          })),
          cases: (entry.tests ?? []).map((testCase) => {
            const result = current.cases.find((one) => one.id === testCase.id);
            return {
              id: testCase.id,
              ask: testCase.ask,
              must: testCase.must,
              mustNot: testCase.mustNot,
              passed: result?.passed ?? false,
              whyNot: result
                ? [
                    ...result.verdicts
                      .filter((verdict) => !verdict.ok)
                      .map((verdict) => `${verdict.kind}: ${verdict.item}`),
                    ...result.ruleFailures.map((failure) => failure.detail),
                  ]
                : [],
            };
          }),
        }),
      },
    ],
  });
  const parsed = jsonFrom(reply.content) as
    | { instructions?: unknown; summary?: unknown }
    | undefined;
  if (
    typeof parsed?.instructions !== "string" ||
    !parsed.instructions.trim() ||
    parsed.instructions.length > 20_000
  ) {
    return undefined;
  }
  return {
    instructions: parsed.instructions.trim(),
    summary:
      typeof parsed.summary === "string"
        ? parsed.summary.trim().slice(0, 1000)
        : "",
  };
}

export async function tune(input: {
  client: ChatClient;
  models: Models & { proposer: string };
  profile: TrialProfile;
  entry: RosterEntry;
  rounds: number;
  outDir: string;
  /** A person's y/n. Only `true` writes anything. */
  confirm: (question: string) => Promise<boolean>;
  print: (text: string) => void;
  progress?: (line: string) => void;
  now?: () => Date;
}): Promise<{ written: string[] }> {
  const now = input.now ?? (() => new Date());
  const written: string[] = [];
  const score = (instructions: string) =>
    scoreEmployee({
      client: input.client,
      models: input.models,
      profile: input.profile,
      entry: input.entry,
      instructions,
      progress: input.progress,
    });
  let current = await score(input.entry.instructions);
  input.print(`Current instruction: ${scoreText(current)}.`);
  for (let round = 1; round <= input.rounds; round++) {
    if (current.passed === current.total) {
      input.print("Every case passes; there is nothing left to improve.");
      break;
    }
    const proposal = await propose(
      input.client,
      input.models.proposer,
      input.entry,
      current,
    );
    if (!proposal || proposal.instructions === current.instructions) {
      input.print(`Round ${round}: no usable proposal.`);
      continue;
    }
    const scored = await score(proposal.instructions);
    const comparison = compareScores(current, scored);
    if (!beats(comparison)) {
      input.print(
        `Round ${round}: the proposal scored ${scoreText(scored)} against ${scoreText(current)}${comparison.newRuleFailures.length > 0 ? " and adds a rule failure" : ""}; not better, discarded.`,
      );
      continue;
    }
    const stamp = now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*$/, "")
      .replace("T", "-");
    const path = join(
      input.outDir,
      `${input.profile.customer.id}-${input.entry.key}-proposal-${stamp}-r${round}.json`,
    );
    input.print(
      [
        "",
        `Round ${round}: the proposal beats the current instruction, ${scoreText(current)} → ${scoreText(scored)}.`,
        proposal.summary ? `What changed: ${proposal.summary}` : "",
        "",
        lineDiff(current.instructions, proposal.instructions),
        "",
        ...scored.cases.map((result) => {
          const was = current.cases.find((one) => one.id === result.id);
          return `  ${result.id}: ${was?.passed ? "pass" : "fail"} → ${result.passed ? "pass" : "fail"}`;
        }),
        "",
      ]
        .filter((line, index, all) => line !== "" || all[index - 1] !== "")
        .join("\n"),
    );
    const approved = await input.confirm(
      `Write this proposal to ${path}? (y/N) `,
    );
    if (!approved) {
      input.print("Not written.");
      continue;
    }
    const change: ProposedChange = {
      format: CHANGE_FORMAT,
      customer: input.profile.customer.id,
      employee: input.entry.key,
      instructions: proposal.instructions,
      source: "tune",
      ...(proposal.summary ? { summary: proposal.summary } : {}),
      createdAt: now().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(change, null, 2)}\n`, { flag: "wx" });
    written.push(path);
    input.print(
      `Written. Next: bun scripts/ark-eval.ts run --profile <profile> --proposed ${path}`,
    );
    current = scored;
  }
  return { written };
}
