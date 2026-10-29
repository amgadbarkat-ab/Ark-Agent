import type { Message } from "@ag-ui/core";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ReadAloud } from "@/components/channels/read-aloud";
import { ReadAloudSetting } from "@/components/settings/read-aloud";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { MAX_SPEECH_CHARACTERS } from "../../shared/speech";
import { settleReactWork } from "./settle-react-work";

/**
 * When "Read aloud" is drawn under a digital employee's message, and what pressing it sends.
 *
 * The rule is the server's own (shared/speech.ts): on only where the deployment has it on, only for
 * Arabic or English, never for Greek or any other script, and never for a reply still being written.
 * `fetch` is stubbed so the one request the control makes can be read back: it names the message
 * and the conversation, never the words.
 */
let requests: { url: string; body: unknown }[] = [];
let realFetch: typeof fetch;
let realPlay: HTMLMediaElement["play"];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "audio/wav" },
    });
  }) as typeof fetch;
  realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  URL.createObjectURL ??= () => "blob:read-aloud";
  URL.revokeObjectURL ??= () => {};
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  requests = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  HTMLMediaElement.prototype.play = realPlay;
  GlobalRegistrator.unregister();
});

function deployment(readAloud: DeploymentCapabilities["readAloud"]) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    readAloud,
  } satisfies DeploymentCapabilities);
}

const BOTH: NonNullable<DeploymentCapabilities["readAloud"]> = {
  languages: ["ar", "en"],
  attribution: "Powered by Example",
};

function control(text: string) {
  return render(
    <ReadAloud channelId="channel-1" messageId="message-1" text={text} />,
  ).queryByRole("button", { name: "Read aloud" });
}

test("off on the deployment means no control, even for English", () => {
  deployment(null);
  expect(control("The report is ready.")).toBeNull();
});

test("offered for English and Arabic", () => {
  deployment(BOTH);
  expect(control("The report is ready.")).not.toBeNull();
  cleanup();
  expect(control("التقرير جاهز.")).not.toBeNull();
});

test("never offered for Greek, a Greek letter in English, or another script", () => {
  deployment(BOTH);
  for (const text of [
    "Η αναφορά είναι έτοιμη.",
    "The error is about 2σ.",
    "Отчёт готов.",
  ]) {
    expect(control(text)).toBeNull();
    cleanup();
  }
});

test("not offered for a language the deployment has no voice for, or a message too long", () => {
  deployment({ languages: ["en"], attribution: null });
  expect(control("التقرير جاهز.")).toBeNull();
  cleanup();
  expect(control("word ".repeat(MAX_SPEECH_CHARACTERS))).toBeNull();
});

test("pressing it names the message, says the voice is synthetic, and plays", async () => {
  deployment(BOTH);
  const view = render(
    <ReadAloud channelId="channel-1" messageId="message-1" text="Hello." />,
  );
  const button = view.getByRole("button", { name: "Read aloud" });
  expect(button.getAttribute("title")).toContain("synthetic voice");
  expect(button.getAttribute("title")).toContain("Powered by Example");
  fireEvent.click(button);
  await waitFor(() => expect(view.getByText("Synthetic voice")).toBeDefined());
  expect(requests).toEqual([
    {
      url: "/api/speech",
      body: { channelId: "channel-1", messageId: "message-1" },
    },
  ]);
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Stop reading aloud" }),
    ).toBeDefined(),
  );
});

test("in a conversation: only the digital employee's settled replies, and only with a channel", () => {
  deployment(BOTH);
  const messages: Message[] = [
    { id: "q1", role: "user", content: "Summarise it" },
    { id: "a1", role: "assistant", content: "Here is the summary." },
    { id: "q2", role: "user", content: "And in Arabic?" },
    { id: "a2", role: "assistant", content: "هذا هو الملخص" },
  ];
  const settled = render(
    <ChatTranscript channelId="channel-1" messages={messages} />,
  );
  expect(settled.getAllByRole("button", { name: "Read aloud" })).toHaveLength(
    2,
  );
  cleanup();

  // The reply to the newest question is still being written, so only the earlier one is offered.
  const busy = render(
    <ChatTranscript busy channelId="channel-1" messages={messages} />,
  );
  expect(busy.getAllByRole("button", { name: "Read aloud" })).toHaveLength(1);
  cleanup();

  // A conversation that has no channel yet has nothing to name the message by.
  const unsaved = render(<ChatTranscript messages={messages} />);
  expect(unsaved.queryByRole("button", { name: "Read aloud" })).toBeNull();
});

test("Preferences explain it and carry the model's credit only where it is on", () => {
  deployment(null);
  expect(render(<ReadAloudSetting />).queryByText("Read aloud")).toBeNull();
  cleanup();
  deployment(BOTH);
  const view = render(<ReadAloudSetting />);
  expect(view.getByText("Powered by Example")).toBeDefined();
  expect(view.getByText(/Arabic and English/)).toBeDefined();
});
