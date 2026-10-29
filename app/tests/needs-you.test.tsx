import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { ApprovalCard } from "@/components/gallery/decisions";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { channelKeys } from "@/lib/channels/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";

/**
 * "Needs you": the count beside Requests, and an approval card kept in step with its row.
 *
 * Desk #69 was the Requests page saying nothing was waiting while a card waited in a chat. The card
 * now registers itself, answers itself when decided from Requests, and records an answer given on
 * it, so the two places cannot disagree.
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
let handle: (url: string, init?: RequestInit) => Response | undefined;
const seen: { url: string; method: string; body?: unknown }[] = [];

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
      seen.push({
        url,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return handle(url, init) ?? Response.json({});
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

function client(staleTime = 0) {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime } },
  });
}

test("the sidebar shows how many things need the person beside Requests", async () => {
  handle = (url) =>
    url.startsWith("/api/approvals/count")
      ? Response.json({ pending: 3 })
      : undefined;
  // Seeded data stays put; only the count is asked for.
  const queryClient = client(Number.POSITIVE_INFINITY);
  queryClient.setQueryData(userPreferencesQueryOptions("user").queryKey, {
    messageListEmphasis: "thread",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "user",
    email: "user@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const label = await view.findByText("Needs you");
  const count = label.parentElement;
  expect(count?.textContent).toBe("Needs you3");
  expect(count?.getAttribute("title")).toBe("3 need you");
  const requests = view.getByRole("link", { name: /Requests/ });
  expect(requests.textContent).toContain("Needs you");
});

const ARGS = {
  title: "Refund this order?",
  summary: "Charged twice.",
  details: [{ label: "Amount", value: "$128.40" }],
};

const row = (status: string) => ({
  id: "apr_card",
  kind: "chat.card",
  summary: "Refund this order?: Charged twice.",
  status,
  result: null,
  requestedBy: { id: "rita", name: "Rita" },
  target: null,
  toolCallId: "call-1",
  createdAt: new Date().toISOString(),
  expiresAt: new Date().toISOString(),
  decidedAt: null,
});

function drawCard(
  respond: (result: unknown) => Promise<void>,
  queryClient = client(),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ApprovalCard
        agentId="rita"
        args={ARGS}
        respond={respond}
        result={undefined}
        status="executing"
        toolCallId="call-1"
      />
    </QueryClientProvider>,
  );
}

test("a waiting card puts itself in Requests, and answers itself when approved there", async () => {
  // Registered while pending; by the time the card looks at its row, somebody has approved it in
  // Requests. (The card keeps looking every few seconds while it waits; the query library runs no
  // timers under this test DOM, so the first look is the one exercised.)
  handle = (url, init) => {
    if (url === "/api/approvals/cards" && init?.method === "POST") {
      return Response.json({ approval: row("pending") });
    }
    if (url === "/api/approvals/apr_card") {
      return Response.json({ approval: row("approved") });
    }
    return undefined;
  };
  const answers: unknown[] = [];
  drawCard(async (result) => {
    answers.push(result);
  });

  await waitFor(() =>
    expect(
      seen.find((one) => one.url === "/api/approvals/cards")?.body,
    ).toEqual({
      toolCallId: "call-1",
      agentId: "rita",
      title: "Refund this order?",
      summary: "Charged twice.",
      details: [{ label: "Amount", value: "$128.40" }],
    }),
  );
  await waitFor(
    () =>
      expect(answers).toEqual([
        { decision: "approved", note: "Approved from Requests." },
      ]),
    { timeout: 8_000 },
  );
}, 15_000);

test("answering on the card records the decision, so Requests and the count clear", async () => {
  handle = (url, init) => {
    if (url === "/api/approvals/cards" && init?.method === "POST") {
      return Response.json({ approval: row("pending") });
    }
    if (url === "/api/approvals/apr_card") {
      return Response.json({ approval: row("pending") });
    }
    if (url === "/api/approvals/apr_card/reject") {
      return Response.json({ approval: row("rejected") });
    }
    return undefined;
  };
  const answers: unknown[] = [];
  const view = drawCard(async (result) => {
    answers.push(result);
  });
  await waitFor(() =>
    expect(seen.some((one) => one.url === "/api/approvals/cards")).toBe(true),
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Decline" }));
  await waitFor(() =>
    expect(
      seen.some(
        (one) =>
          one.url === "/api/approvals/apr_card/reject" && one.method === "POST",
      ),
    ).toBe(true),
  );
  expect(answers).toEqual([{ decision: "declined", note: undefined }]);
});
