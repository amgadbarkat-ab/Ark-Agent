#!/usr/bin/env bun
/**
 * Asks every digital employee three things a person asks first, on a real model, and checks the answers.
 *
 *   bun scripts/conversation-check.ts --url https://api.openai.com/v1 --token <key> --model gpt-4.1-mini
 *   bun scripts/conversation-check.ts --url http://127.0.0.1:8080/v1 --model gemma-4-e2b   # this computer's
 *
 * Any OpenAI-compatible endpoint: Anthropic's included (https://api.anthropic.com/v1). The employees are
 * the ones a desktop starts with (the fintech package) and every ready-made role, with their prompts
 * built by the server's own code, so this checks what is really sent and not a copy of it.
 *
 * Why it exists: on v0.1.14 the DT Lab asked a General Assistant "How are you?" and got the platform's
 * feature list and a "Summary:" line, and "What can you do?" got the same tour instead of its role. A
 * prompt change cannot be checked by a unit test, because what the model does with it is the question.
 *
 * Two answers are checked and one is shown:
 *   - "How are you?"  a line or two: short, no list, no headings, no summary
 *   - "What can you do?"  its own role by name or title, not a tour of the platform
 *   - an off-role request, printed for a person to judge (staying in role is a judgement, not a regex)
 *
 * Exit status 1 when any checked answer fails. The token is read from --token or MODEL_API_KEY and never
 * printed.
 */
import { join } from "node:path";
import { builtInAgentConfiguration } from "../server/src/copilot";
import {
  composeInstruction,
  OFFICIAL_LISTINGS,
} from "../server/src/marketplace/official";
import { loadTenantPackage } from "../server/src/tenant-package";

export const GREETING = "How are you?";
export const CAPABILITIES = "What can you do?";
export const OFF_ROLE = "Can you write me a short poem about football?";

/** The longest a reply to "How are you?" may be and still be the line or two it should be. */
const GREETING_LIMIT = 320;
/** Long enough for a role, its duties and an offer of work; a platform tour runs well past it. */
const CAPABILITIES_LIMIT = 1600;

export type Employee = {
  id: string;
  name: string;
  title: string;
  prompt: string;
};
export type Verdict = { ok: boolean; why: string };

/** "How are you?" answered as one: short, and no list, heading or summary in it. */
export function checkGreeting(reply: string): Verdict {
  const text = reply.trim();
  if (text.length === 0) return { ok: false, why: "no answer" };
  if (text.length > GREETING_LIMIT) {
    return { ok: false, why: `${text.length} characters for a greeting` };
  }
  if (/^\s*(summary|in summary|tl;dr)\b/im.test(text)) {
    return { ok: false, why: "a summary section" };
  }
  if (/^\s*(#{1,6}\s|[-*•]\s|\d+[.)]\s)/m.test(text)) {
    return { ok: false, why: "a list or heading" };
  }
  return { ok: true, why: "short and plain" };
}

/** "What can you do?" answered for the employee's own role, and not as a tour of the platform. */
export function checkCapabilities(reply: string, employee: Employee): Verdict {
  const text = reply.trim();
  if (text.length === 0) return { ok: false, why: "no answer" };
  const lower = text.toLowerCase();
  const named = [employee.name, employee.title]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .some((value) => lower.includes(value));
  if (!named) return { ok: false, why: "does not say which role it is" };
  if (/\ba2ui\b|generative ui|sandboxed (ui|interface)/i.test(text)) {
    return { ok: false, why: "describes the platform's screens" };
  }
  if (text.length > CAPABILITIES_LIMIT) {
    return { ok: false, why: `${text.length} characters` };
  }
  return { ok: true, why: "its own role" };
}

/** Every employee a desktop starts with, and every ready-made role, as the server would prompt them. */
export async function employees(
  root = join(import.meta.dir, ".."),
): Promise<Employee[]> {
  const model = { provider: "openai" as const, defaultModel: "unused" };
  const promptOf = (id: string, name: string, systemPrompt: string) =>
    String(
      builtInAgentConfiguration(
        { id, name, type: "built_in", systemPrompt },
        model,
        // Any key: only the prompt is read, and without one the server builds a refusal instead.
        "unused",
      ).prompt,
    );
  const fintech = await loadTenantPackage(join(root, "examples", "fintech"));
  const packaged = fintech.agents
    .filter((agent) => agent.type === "built_in")
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      prompt: promptOf(
        agent.id,
        agent.name,
        String(agent.configuration.systemPrompt ?? ""),
      ),
    }));
  const roles = OFFICIAL_LISTINGS.map((listing) => ({
    id: listing.slug,
    name: listing.install.name,
    title: listing.install.title,
    prompt: promptOf(
      listing.slug,
      listing.install.name,
      composeInstruction(listing, null),
    ),
  }));
  return [...packaged, ...roles];
}

async function ask(
  options: { url: string; token?: string; model: string },
  system: string,
  question: string,
): Promise<string> {
  const response = await fetch(
    `${options.url.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question },
        ],
        max_tokens: 600,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `the model answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return body.choices?.[0]?.message?.content ?? "";
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: string[]) {
  const url = flag(argv, "--url");
  const model = flag(argv, "--model");
  const only = flag(argv, "--only");
  const token = flag(argv, "--token") ?? process.env.MODEL_API_KEY;
  if (!url || !model) {
    console.error(
      "Usage: bun scripts/conversation-check.ts --url <base url> --model <model> [--token <key>] [--only <id>]",
    );
    process.exit(2);
  }
  const all = (await employees()).filter(
    (employee) => !only || employee.id === only,
  );
  let failed = 0;
  for (const employee of all) {
    const greeting = await ask(
      { url, token, model },
      employee.prompt,
      GREETING,
    );
    const capabilities = await ask(
      { url, token, model },
      employee.prompt,
      CAPABILITIES,
    );
    const offRole = await ask({ url, token, model }, employee.prompt, OFF_ROLE);
    const verdicts = [
      checkGreeting(greeting),
      checkCapabilities(capabilities, employee),
    ];
    const ok = verdicts.every((verdict) => verdict.ok);
    if (!ok) failed += 1;
    console.log(
      `\n${ok ? "PASS" : "FAIL"}  ${employee.name} (${employee.title})`,
    );
    console.log(
      `  How are you?      ${verdicts[0]?.ok ? "ok" : "FAIL"}: ${verdicts[0]?.why}\n    ${greeting.trim().replaceAll("\n", "\n    ")}`,
    );
    console.log(
      `  What can you do?  ${verdicts[1]?.ok ? "ok" : "FAIL"}: ${verdicts[1]?.why}\n    ${capabilities.trim().slice(0, 600).replaceAll("\n", "\n    ")}`,
    );
    console.log(
      `  Off-role (judge it yourself):\n    ${offRole.trim().slice(0, 400).replaceAll("\n", "\n    ")}`,
    );
  }
  console.log(`\n${all.length - failed} of ${all.length} employees passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) await main(process.argv.slice(2));
