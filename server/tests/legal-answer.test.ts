import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { lastValueFrom, Observable, toArray } from "rxjs";
import {
  LEGAL_DISCLAIMER,
  LegalHelperAgent,
} from "../src/marketplace/legal-answer";

const EN = "Draft for review by a qualified lawyer. Not legal advice.";
const EL =
  "Προσχέδιο για έλεγχο από αρμόδιο δικηγόρο. Δεν αποτελεί νομική συμβουλή.";

/** A stand-in model: says what it is given, in the chunks it is given, and finishes. */
type Step = { say: string[] } | { tool: string };

class StandInModel extends AbstractAgent {
  constructor(private readonly script: Step[]) {
    super({ agentId: "legal", description: "legal" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const script = this.script;
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      script.forEach((step, index) => {
        if ("say" in step) {
          const messageId = `m${index}`;
          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          } as BaseEvent);
          for (const delta of step.say)
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta,
            } as BaseEvent);
          subscriber.next({
            type: EventType.TEXT_MESSAGE_END,
            messageId,
          } as BaseEvent);
        } else {
          const toolCallId = `t${index}`;
          subscriber.next({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: step.tool,
          } as BaseEvent);
          subscriber.next({
            type: EventType.TOOL_CALL_END,
            toolCallId,
          } as BaseEvent);
        }
      });
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
  clone(): StandInModel {
    return new StandInModel(this.script);
  }
}

function input(userText: string): RunAgentInput {
  return {
    threadId: "thread",
    runId: "run",
    messages: [{ id: "u1", role: "user", content: userText }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  } as RunAgentInput;
}

async function run(
  script: Step[],
  userText = "Please look at this.",
  isLegalHelper = true,
) {
  const agent = new LegalHelperAgent(
    new StandInModel(script),
    async () => isLegalHelper,
  );
  const events = await lastValueFrom(
    agent.run(input(userText)).pipe(toArray()),
  );
  const messages: string[] = [];
  const order: string[] = [];
  const open = new Map<string, string>();
  for (const event of events as Array<BaseEvent & Record<string, string>>) {
    if (event.type === EventType.TEXT_MESSAGE_START)
      open.set(event.messageId as string, "");
    if (event.type === EventType.TEXT_MESSAGE_CONTENT)
      open.set(
        event.messageId as string,
        (open.get(event.messageId as string) ?? "") + event.delta,
      );
    if (event.type === EventType.TEXT_MESSAGE_END) {
      messages.push(open.get(event.messageId as string) ?? "");
      order.push("text");
    }
    if (event.type === EventType.TOOL_CALL_START) order.push("tool");
  }
  return { events, messages, order, all: messages.join("\n\n") };
}

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("a Legal Helper answer opens and closes with the fixed line, added by the server", () => {
  test("a paraphrase at either end is replaced by the exact line, once at each end", async () => {
    const { all } = await run([
      {
        say: [
          "**Note: this is a draft for your lawyer to review",
          " and is not legal advice.**\n\nThe NDA is mutual and lasts three years.\n\n",
          "Questions for your lawyer: is three years enough?\n\n---\n\n",
          "_This draft should be reviewed by a qualified solicitor; it isn't legal advice._",
        ],
      },
    ]);
    expect(all.startsWith(`${EN}\n\n`)).toBe(true);
    expect(all.endsWith(`\n\n${EN}`)).toBe(true);
    expect(count(all, EN)).toBe(2);
    expect(all).not.toContain("solicitor");
    expect(all).not.toContain("Note: this is a draft");
    expect(all).toContain("The NDA is mutual and lasts three years.");
    expect(all).toContain("Questions for your lawyer: is three years enough?");
  });

  test("the model's own exact copy is not doubled", async () => {
    const { all } = await run([
      { say: [`${EN}\n\nThe NDA is fine on its face.\n\n${EN}`] },
    ]);
    expect(all).toBe(`${EN}\n\nThe NDA is fine on its face.\n\n${EN}`);
  });

  test("an answer written in Greek gets the Greek line", async () => {
    const { all } = await run(
      [
        {
          say: [
            "Σημείωση: προσχέδιο, όχι νομική συμβουλή.\n\nΤο συμφωνητικό είναι αμοιβαίο και ισχύει για τρία χρόνια.",
          ],
        },
      ],
      "Δες αυτό το NDA παρακαλώ.",
    );
    expect(all).toBe(
      `${EL}\n\nΤο συμφωνητικό είναι αμοιβαίο και ισχύει για τρία χρόνια.\n\n${EL}`,
    );
    expect(LEGAL_DISCLAIMER).toEqual({ en: EN, el: EL });
  });

  test("across a tool call the opening goes on the first message and the closing on the last", async () => {
    const { messages, order } = await run([
      { say: ["Let me read the playbook first."] },
      { tool: "read_file" },
      { say: ["The playbook allows three years. Not legal advice."] },
    ]);
    expect(order).toEqual(["text", "tool", "text"]);
    expect(messages[0]).toBe(`${EN}\n\nLet me read the playbook first.`);
    expect(messages[1]).toBe(`The playbook allows three years.\n\n${EN}`);
  });

  test("a run that ends on a tool call still closes with the line", async () => {
    const { messages, order } = await run([
      { say: ["Saving the playbook now."] },
      { tool: "save_playbook" },
    ]);
    expect(order).toEqual(["text", "tool", "text"]);
    expect(messages[0]).toBe(`${EN}\n\nSaving the playbook now.`);
    expect(messages[1]).toBe(EN);
  });

  test("a sentence that mentions a lawyer without being the disclaimer is kept", async () => {
    const { all } = await run([
      {
        say: [
          "Clause 7 is a penalty.\n\nRed: do not sign; your lawyer reviews it in full.",
        ],
      },
    ]);
    expect(all).toContain("Red: do not sign; your lawyer reviews it in full.");
  });

  test("any other digital employee is left exactly as it spoke", async () => {
    const { all } = await run(
      [{ say: ["Not legal advice.\n\nHello."] }],
      "hi",
      false,
    );
    expect(all).toBe("Not legal advice.\n\nHello.");
  });
});

const TRIAGE_TABLE = [
  "| Point | Colour | What the text says | Why it matters | Suggested wording |",
  "|---|---|---|---|---|",
  '| Mutual or one-way | 🟢 Green | Clause 1: "each party" | Fits | none |',
  '| Ban on hiring staff (non-solicit) | 🟡 Yellow | Clause 9: "neither party shall hire" | Does not belong in an NDA | Delete clause 9 |',
  '| Term | Yellow | Clause 4: "five years" | Longer than the playbook | Three years |',
].join("\n");

describe("an NDA triage ends with exactly one overall rating, and a no-hire clause is always Red", () => {
  test("a no-hire row marked Yellow becomes Red, and the overall rating is Red", async () => {
    const { all } = await run(
      [
        {
          say: [
            `NDA triage.\n\n${TRIAGE_TABLE}\n\nOverall rating: Yellow/Red. Raise clause 9 first.`,
          ],
        },
      ],
      "/legal-nda-triage here is the NDA",
    );
    expect(all).toContain(
      "| Ban on hiring staff (non-solicit) | Red | Clause 9:",
    );
    expect(all).not.toContain("Yellow/Red");
    expect(count(all.toLowerCase(), "overall rating")).toBe(1);
    expect(all.endsWith(`**Overall rating: Red**\n\n${EN}`)).toBe(true);
  });

  test("a triage with no overall rating is given the worst colour in its table", async () => {
    const table = TRIAGE_TABLE.split("\n")
      .filter((line) => !line.includes("hiring"))
      .join("\n");
    const { all } = await run(
      [{ say: [`Here is the triage.\n\n${table}`] }],
      "Can you triage this NDA?",
    );
    expect(all.endsWith(`**Overall rating: Yellow**\n\n${EN}`)).toBe(true);
  });

  test("a no-hire row that says there is no such clause is not forced to Red", async () => {
    const table = [
      "| Point | Colour | What the text says |",
      "|---|---|---|",
      "| Non-solicit | Green | None present |",
    ].join("\n");
    const { all } = await run(
      [{ say: [`${table}\n\nOverall: Green`] }],
      "triage this NDA",
    );
    expect(all).toContain("| Non-solicit | Green | None present |");
    expect(all.endsWith(`**Overall rating: Green**\n\n${EN}`)).toBe(true);
  });

  test("a Greek triage gets its overall rating in Greek", async () => {
    const table = [
      "| Σημείο | Χρώμα | Τι λέει το κείμενο |",
      "|---|---|---|",
      "| Απαγόρευση πρόσληψης προσωπικού | Κίτρινο | Άρθρο 9 |",
    ].join("\n");
    const { all } = await run(
      [{ say: [`Αξιολόγηση του συμφωνητικού.\n\n${table}`] }],
      "Κάνε αξιολόγηση σε αυτό το NDA",
    );
    expect(all).toContain(
      "| Απαγόρευση πρόσληψης προσωπικού | Κόκκινο | Άρθρο 9 |",
    );
    expect(all.endsWith(`**Συνολική αξιολόγηση: Κόκκινο**\n\n${EL}`)).toBe(
      true,
    );
  });

  test("a contract review that is not an NDA is not given an overall rating", async () => {
    const { all } = await run(
      [{ say: [`Contract review.\n\n${TRIAGE_TABLE}`] }],
      "Review this supply contract",
    );
    expect(all.toLowerCase()).not.toContain("overall rating");
  });
});
