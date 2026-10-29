import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { type RunAgentInput, RunAgentInputSchema } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  stashCarriedDraft,
  stashFirstMessage,
} from "@/components/channels/transcript-messages";
import type { AgentChannel } from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * THE NEXT MESSAGE, TYPED WHILE THE FIRST ONE IS STILL BEING ANSWERED.
 *
 * DT Lab, v0.1.19, on the desktop app with a model on the computer that takes one to three minutes
 * to answer: the first characters typed into the composer were lost. A conversation starts on
 * another screen — the home composer or `/channel/new` — and the first message is sent from there.
 * That screen then navigates to the new conversation, and the box the caret was in goes with it,
 * so the caret is left on the page body. The new conversation's composer was never asked to take
 * it. So the person, who had just pressed Enter and went on typing while the answer was minutes
 * away, typed into nothing until they noticed and clicked the box.
 *
 * Real provider and real `ChannelChat`; only the HTTP boundary is synthetic, and the run behind the
 * first message is held open the whole time, which is the slow model.
 */

const NativeResponse = globalThis.Response;
const channel: AgentChannel = {
  id: "seed-focus-channel",
  name: "Seed focus",
  agentIds: ["seed-focus-bot"],
  threadId: "seed-focus-thread",
  active: true,
  lastMessageAt: null,
};

let originalFetch: typeof fetch;
let runs: RunAgentInput[] = [];
/** The stream of the run in flight, so the test decides when the model answers. */
let answer: ((events: unknown[]) => void) | undefined;

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A run that has started and has not answered yet. */
function slowRun(input: RunAgentInput) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      });
      answer = (events) => {
        for (const event of events) send(event);
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        });
        controller.close();
        answer = undefined;
      };
    },
  });
  return new NativeResponse(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/seed-focus-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "seed-focus-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        runs.push(body);
        return slowRun(body);
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (url.pathname === "/api/voice/sessions")
        return NativeResponse.json({ sessions: [], nextCursor: null });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: [] });
      // Anything else this screen asks for is a capability it can do without.
      return new NativeResponse(null, { status: 404 });
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});

afterEach(async () => {
  // The model answers, so nothing is left streaming into the next test.
  await act(async () => {
    answer?.([]);
  });
  cleanup();
  queryClient.clear();
  runs = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function mount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <ChannelChat channel={channel} runtimeAgentId="seed-focus-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

test("typing on after a first message sent from another screen lands in the composer while it is answered", async () => {
  // What the home composer and `/channel/new` do on send, before they navigate here. The caret
  // they held leaves with them: nothing on this page is focused when it mounts.
  stashFirstMessage(channel.id, "Draft the weekly report.");
  const view = mount();
  await waitFor(() => expect(runs).toHaveLength(1));
  expect(runs[0]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Draft the weekly report.",
  });

  // Still being answered, and the person types on without clicking anything first. Where their
  // keys go is wherever the caret is, so that is the assertion; compared as a boolean because a
  // failing `toBe` on two elements prints the whole document.
  const box = view.getByRole("textbox", { name: "Message" });
  expect(document.activeElement === box).toBe(true);

  // And the box takes them while the turn is in flight. A browser puts a caret in an editor it
  // focuses and happy-dom does not, so that one step is done here; nothing is clicked.
  const caret = document.createRange();
  caret.selectNodeContents(box);
  caret.collapse(false);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.keyboard("Also add the budget");
  expect(box.textContent).toBe("Also add the budget");
  expect(runs).toHaveLength(1);
});

test("what was typed on the home screen while the employee was picked is waiting in the box", async () => {
  // The home composer stays writable while the first message is routed, and the page is replaced
  // when the conversation opens; `useStartChannel` stashes what was in the box at that moment.
  stashFirstMessage(channel.id, "Draft the weekly report.");
  stashCarriedDraft(channel.id, "and send it to Maria");
  const view = mount();
  await waitFor(() => expect(runs).toHaveLength(1));

  const box = view.getByRole("textbox", { name: "Message" });
  expect(box.textContent).toBe("and send it to Maria");
  // Waiting, not sent: it is the person's next message, and only they decide when it goes.
  expect(runs).toHaveLength(1);
});

test("a conversation opened any other way leaves the caret where it is", async () => {
  // Opened from the sidebar, with the mouse: nothing was typed a moment ago, so nothing is owed.
  const view = mount();
  await view.findByRole("textbox", { name: "Message" });
  await settleReactWork();

  expect(
    document.activeElement === view.getByRole("textbox", { name: "Message" }),
  ).toBe(false);
});
