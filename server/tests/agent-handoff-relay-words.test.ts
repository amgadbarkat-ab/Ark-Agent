import { describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { readColleagueAnswer } from "../../shared/handoff-markers";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import type { AuditStore } from "../src/audit";
import type { WorkItem, WorkQueue } from "../src/work/queue";

/**
 * A colleague's answer, from the ask to the conversation the person is watching.
 *
 * FOUND IN THE DT LAB (v0.1.19, step 1), on the desktop's small local model. The Chief of
 * Operations was asked to get three risks of a €310 dinner with no receipt from Customer Support.
 * The "Asked Customer Support" card appeared and the lead posted a report, and the three risks were
 * nowhere: the colleague's words only ever reached the lead's prompt, and the lead was told to say
 * them "in a sentence or two". A small model did exactly that.
 *
 * So this runs the real runner and the real delivery end to end, with two stand-in models: the
 * colleague answers properly, and the lead, like a small model, answers its relay turn with a short
 * report that repeats none of it. The person must still be able to read the colleague's answer,
 * word for word and attributed, in their conversation.
 */

const RISKS = [
  "1. Without a receipt there is no proof the dinner was a business expense.",
  "2. The VAT on €310 cannot be reclaimed without an invoice.",
  "3. Approving it sets a precedent that receipts are optional.",
].join("\n");

const LEAD_REPORT = "Customer Support got back to me. All handled.";

const ASK: HandoffWork = {
  fromBotId: "chief",
  toBotId: "support",
  fromName: "Chief of Operations",
  toName: "Customer Support",
  actorId: "user-1",
  threadId: "lead-thread",
  runId: "run-1",
  depth: 1,
  task: "List three risks of approving a €310 client dinner with no receipt.",
};

/** The queue, kept in memory: whatever is offered is claimed on the next sweep. */
function memoryQueue() {
  const waiting: WorkItem[] = [
    { kind: "bot.message", key: "run-1:ask", payload: ASK, attempts: 1 },
  ] as unknown as WorkItem[];
  return {
    claim: async () => waiting.splice(0),
    renew: async () => true,
    finish: async () => true,
    release: async () => true,
    offer: async ({
      kind,
      key,
      payload,
    }: {
      kind: string;
      key: string;
      payload: Record<string, unknown>;
    }) => {
      waiting.push({ kind, key, payload, attempts: 1 } as unknown as WorkItem);
    },
  } as unknown as WorkQueue;
}

/** A stand-in model: whatever it is asked, it says this. */
function standIn(says: string): AbstractAgent {
  const agent = {
    threadId: "",
    messages: [] as unknown[],
    setMessages(messages: unknown[]) {
      agent.messages = messages;
    },
    runAgent: async (
      _input: unknown,
      config?: { onEvent?: (emitted: unknown) => void },
    ) => {
      for (const event of [
        { type: "TEXT_MESSAGE_START" },
        { type: "TEXT_MESSAGE_CONTENT", delta: says },
        { type: "TEXT_MESSAGE_END" },
      ])
        config?.onEvent?.({ event });
    },
  };
  return agent as unknown as AbstractAgent;
}

describe("a colleague's answer reaches the person", () => {
  test("word for word, even when the lead's report leaves it out", async () => {
    /* What each conversation ends up holding, as the platform would keep it. */
    const transcripts = new Map<
      string,
      Array<{ role: string; text: string }>
    >();
    const keep = (threadId: string, role: string, text: string) => {
      const kept = transcripts.get(threadId) ?? [];
      kept.push({ role, text });
      transcripts.set(threadId, kept);
    };
    let scratch = 0;

    const auditStore: AuditStore = { insert: async () => {} };
    const runner = createHandoffRunner({
      queue: memoryQueue(),
      owner: "replica-a",
      sign: () => "signed",
      auditStore,
      delivery: createHandoffDelivery({
        agentFor: async ({ botId }) =>
          botId === "support" ? standIn(RISKS) : standIn(LEAD_REPORT),
        history: async ({ threadId }) =>
          (transcripts.get(threadId) ?? []).map((message, index) => ({
            id: `m${index}`,
            role: message.role,
            content: message.text,
          })),
        mintThreadId: () => `scratch-${++scratch}`,
        newRunId: () => "run-2",
        lock: {
          acquire: async ({ runId }) => ({ runId }),
          renew: async () => {},
          release: async () => {},
        },
        // The platform's runner, as far as a transcript is concerned: it keeps what it is told to
        // keep from the input, then whatever the agent said.
        runner: {
          run: (request) =>
            new Observable<BaseEvent>((subscriber) => {
              for (const message of (request.persistedInputMessages ??
                []) as Array<{ role: string; content: string }>)
                keep(request.threadId, message.role, message.content);
              void (
                request.agent as unknown as {
                  runAgent: (
                    input: unknown,
                    config: { onEvent: (emitted: unknown) => void },
                  ) => Promise<void>;
                }
              )
                .runAgent(request.input, {
                  onEvent: (emitted) => {
                    const { event } = emitted as {
                      event: { type: string; delta?: string };
                    };
                    if (event.type === "TEXT_MESSAGE_CONTENT")
                      keep(request.threadId, "assistant", event.delta ?? "");
                  },
                })
                .then(() => {
                  subscriber.next({ type: "RUN_FINISHED" } as BaseEvent);
                  subscriber.complete();
                });
            }),
        },
      }),
    });

    // The ask, then the relay it queued.
    await runner.sweep();
    await runner.sweep();

    const lead = transcripts.get("lead-thread") ?? [];
    // The lead spoke in the person's conversation, and like a small model it left the risks out.
    expect(lead.map((message) => message.text)).toContain(LEAD_REPORT);
    // The colleague's own words are there anyway, whole, and drawn as Customer Support's.
    const answers = lead
      .map((message) => readColleagueAnswer(message.text))
      .filter((answer) => answer !== null);
    expect(answers).toEqual([{ name: "Customer Support", answer: RISKS }]);
    // Shown before the lead's report, which is what it reports on.
    const at = lead.findIndex((message) => readColleagueAnswer(message.text));
    expect(at).toBeLessThan(
      lead.findIndex((message) => message.text === LEAD_REPORT),
    );
  });
});
