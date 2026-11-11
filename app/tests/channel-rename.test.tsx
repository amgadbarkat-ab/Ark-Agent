import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenameChannelForm } from "@/components/app-sidebar/channel";

/**
 * Desk #83 (e): right-click on a conversation offered only Pin and Delete, no rename. The menu item
 * opens a dialog around this form; Base UI's menu and dialog do not render in this test DOM, so the
 * form is tested on its own.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

class QuietObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalObserver: typeof IntersectionObserver;
const seen: { url: string; method: string; body?: unknown }[] = [];
let refuse = false;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    QuietObserver as unknown as typeof IntersectionObserver;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/title"))
        return refuse
          ? Response.json({ error: "Channel not found." }, { status: 404 })
          : Response.json(body);
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  seen.length = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function renderDialog(onClose = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RenameChannelForm
        channelId="channel-1"
        current="Wine shop operations management"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

test("the rename dialog opens on the current title and saves the new one", async () => {
  let closed = 0;
  const view = renderDialog(() => {
    closed += 1;
  });
  const user = userEvent.setup({ document });

  const field = (await view.findByLabelText(
    "Conversation name",
  )) as HTMLInputElement;
  expect(field.value).toBe("Wine shop operations management");
  await user.clear(field);
  await user.type(field, "  Διαχείριση κάβας ");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(closed).toBe(1));
  expect(seen.find((call) => call.url.endsWith("/title"))).toEqual({
    url: "/api/channels/channel-1/title",
    method: "PUT",
    body: { title: "Διαχείριση κάβας" },
  });
});

test("an empty name cannot be saved", async () => {
  const view = renderDialog();
  const user = userEvent.setup({ document });
  const field = (await view.findByLabelText(
    "Conversation name",
  )) as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "   ");
  await waitFor(() =>
    expect(
      (view.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
});

test("a refused rename keeps the dialog open and says why", async () => {
  refuse = true;
  let closed = 0;
  const view = renderDialog(() => {
    closed += 1;
  });
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: "Save" }));
  expect((await view.findByRole("alert")).textContent).toContain(
    "Channel not found.",
  );
  expect(closed).toBe(0);
  refuse = false;
});
