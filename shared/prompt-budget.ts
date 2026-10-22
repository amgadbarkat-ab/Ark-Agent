/**
 * Keep what is sent to a model with a small window inside it.
 *
 * THE PROMPT WAS LARGER THAN THE MODEL'S MEMORY. A "hi" to the model on this computer was a request
 * of 21,097 tokens against a window of 16,384, and the model refused it. Most of those tokens were
 * not the conversation: they were about 40 tool definitions, sent whole with every message, most of
 * which a greeting has no use for (charts, forms, file and command tools, the tools that make new
 * digital employees). A large hosted model carries that without noticing; a model on a laptop
 * cannot, and even when it fits, reading it before the first word of an answer is the minutes a
 * person waits.
 *
 * This runs only when the deployment says how big the window is (`BOT_CONTEXT_TOKENS`, written by
 * the desktop app for the model it runs itself), and only when the tools would not fit. Then the
 * tools the employee's own work stands on stay, and three groups are offered when the person's
 * message is about them or the thread has already used them.
 *
 * What stays, always: the browser tools, asking the person, and every tool the deployment itself
 * runs for this employee (its grants, its team, its memories). Those are its abilities, and a team
 * tool the model never sees is how an employee came to say it had no way to reach a colleague.
 *
 * It is not a boundary and must never be mistaken for one: what an employee may do is its grants,
 * checked where the tool runs. This only chooses what to put in front of the model on this turn.
 * When it is wrong the model says so and the person asks again by name, so every doubt here
 * resolves towards offering a group rather than hiding it.
 *
 * The same rules as `agent-langgraph-agui/src/prompt_budget.py`, which the harness runs.
 */
import type { RunAgentInput } from "@ag-ui/core";

type Tool = RunAgentInput["tools"][number];
type Message = RunAgentInput["messages"][number];

/** Share of the window the tools may take. The role, the guidance and the conversation need the rest. */
export const TOOL_SHARE = 0.4;

const FILES = new Set([
  "computer_list_files",
  "computer_read_file",
  "computer_write_file",
  "computer_run_command",
]);
const MANAGE = new Set([
  "list_bots",
  "read_bot",
  "list_bot_skills",
  "save_bot",
  "list_skills",
  "read_skill",
  "list_skill_tools",
  "save_skill",
]);
/** A component a person looks at: showBarChart, showTable, askApproval, askForm. */
const VISUAL_NAME = /^(show|ask)[A-Z]/;

type Group = "visual" | "manage" | "files";
const GROUPS: Group[] = ["visual", "manage", "files"];

const WANTS: Record<Group, string[]> = {
  visual: [
    "chart",
    "graph",
    "plot",
    "table",
    "dashboard",
    "metric",
    "progress",
    "checklist",
    "report",
    "form",
    "approv",
    "choose",
    "choice",
    "quote",
    "visual",
    "diagram",
    "γραφημ",
    "διαγραμμ",
    "πινακ",
    "πίνακ",
    "φορμ",
    "φόρμ",
    "εγκριση",
    "έγκριση",
    "αναφορ",
    "مخطط",
    "جدول",
    "نموذج",
    "تقرير",
    "رسم",
  ],
  manage: [
    "employee",
    "hire",
    "skill",
    "new role",
    "colleague",
    "δεξιοτ",
    "υπαλλ",
    "ψηφιακ",
    "موظف",
    "مهار",
  ],
  files: [
    "file",
    "folder",
    "workspace",
    "notes",
    "save",
    "write",
    "csv",
    "document",
    "download",
    "command",
    "script",
    "αρχει",
    "αρχεί",
    "φακελ",
    "φάκελ",
    "σημειω",
    "αποθηκευ",
    "ملف",
    "مجلد",
  ],
};

/** Lower case without accents, so "γράφημα" and "γραφημα" are the same word. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");
}

const FOLDED_WANTS = Object.fromEntries(
  GROUPS.map((group) => [group, WANTS[group].map(fold)]),
) as Record<Group, string[]>;

/** The window of the model on this computer, or undefined when the deployment did not say. */
export function windowFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): number | undefined {
  const tokens = Number.parseInt(
    (environment.BOT_CONTEXT_TOKENS ?? "").trim(),
    10,
  );
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/** About how many tokens a tool definition takes: its name, description and schema. */
export function cost(tool: Tool): number {
  return Math.floor(
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }).length / 3,
  );
}

function textOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join(" ");
}

function lastPersonText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return fold(textOf(message));
  }
  return "";
}

function alreadyUsed(messages: Message[]): Set<string> {
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls = (
      message as {
        toolCalls?: { name?: string; function?: { name?: string } }[];
      }
    ).toolCalls;
    for (const call of calls ?? []) {
      const name = call.function?.name ?? call.name;
      if (name) used.add(name);
    }
  }
  return used;
}

function groupOf(tool: Tool, deployment: ReadonlySet<string>): Group | null {
  if (deployment.has(tool.name)) return null;
  if (FILES.has(tool.name)) return "files";
  if (MANAGE.has(tool.name)) return "manage";
  if (VISUAL_NAME.test(tool.name)) return "visual";
  return null;
}

/**
 * The tools to offer on this turn, and the names that were left out.
 *
 * Everything is offered unless the window is known and the tools would take more than their share of
 * it. Then groups the person did not ask about and the thread has not used are left out, biggest
 * first, until they fit or nothing optional is left.
 */
export function narrowTools(
  tools: Tool[],
  deployment: ReadonlySet<string>,
  messages: Message[],
  tokens: number | undefined = windowFromEnvironment(),
): { offered: Tool[]; leftOut: string[] } {
  if (tokens === undefined) return { offered: tools, leftOut: [] };
  const budget = Math.floor(tokens * TOOL_SHARE);
  const total = (list: Tool[]) =>
    list.reduce((sum, tool) => sum + cost(tool), 0);
  if (total(tools) <= budget) return { offered: tools, leftOut: [] };

  const asked = lastPersonText(messages);
  const used = alreadyUsed(messages);
  const wanted = new Set(
    GROUPS.filter((group) =>
      FOLDED_WANTS[group].some((word) => asked.includes(word)),
    ),
  );
  const inUse = new Set(
    tools
      .filter((tool) => used.has(tool.name))
      .map((tool) => groupOf(tool, deployment)),
  );
  const optional = new Set(
    GROUPS.filter((group) => wanted.has(group) || inUse.has(group)),
  );

  let offered = [...tools];
  for (const group of GROUPS) {
    if (total(offered) <= budget) break;
    if (optional.has(group)) continue;
    offered = offered.filter((tool) => groupOf(tool, deployment) !== group);
  }
  return {
    offered,
    leftOut: tools
      .filter((tool) => !offered.includes(tool))
      .map((tool) => tool.name),
  };
}

/** The tools the deployment runs for this employee, as it names them in the run's forwarded props. */
export function deploymentToolsOf(forwardedProps: unknown): Set<string> {
  const names = (
    forwardedProps as { openbotDeploymentTools?: unknown } | undefined
  )?.openbotDeploymentTools;
  return new Set(
    Array.isArray(names)
      ? names.filter((name) => typeof name === "string")
      : [],
  );
}

/** Said to the model, so it does not reach for a tool it was not given. */
export function leftOutNote(names: string[]): string {
  return (
    `These tools exist but are not offered on this turn: ${names.join(", ")}. ` +
    "If the person's task needs one, tell them to ask for it by name (for example to save a " +
    "file, show a chart or hire a digital employee) and do what you can in words meanwhile."
  );
}
