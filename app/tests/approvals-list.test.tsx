import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalsList } from "@/components/approvals/approvals-list";

/**
 * The person's "Needs you" list: everything waiting on them, in one place.
 *
 * A request says who asked and what will happen — for a held call, with its exact arguments —
 * nothing happens until Approve or Decline is pressed, and each press sends exactly that one
 * decision. Approval cards raised in conversations are listed here too (desk #69).
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const pending = {
  id: "apr_1",
  kind: "routine.delete",
  summary: "Delete Ben's weekly report routine",
  details: [],
  status: "pending",
  result: null,
  requestedBy: { id: "lead", name: "Ana" },
  target: { id: "ben", name: "Ben" },
  channelId: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  decidedAt: null,
};

const heldCall = {
  ...pending,
  id: "apr_2",
  kind: "tool.call",
  summary: "Call send_message on Messenger, which changes something there.",
  details: [
    { label: "Tool", value: "send_message on Messenger" },
    { label: "to", value: "ana@example.test" },
    { label: "body", value: "The invoice is attached." },
  ],
  requestedBy: { id: "rita", name: "Rita" },
  target: null,
  channelId: "ch-1",
};

const chatCard = {
  ...pending,
  id: "apr_3",
  kind: "chat.card",
  summary: "Refund this order?: Charged twice.",
  details: [{ label: "Amount", value: "$128.40" }],
  requestedBy: { id: "rita", name: "Rita" },
  target: null,
  channelId: "ch-2",
};

function serve(rows: unknown[]) {
  const posts: string[] = [];
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(path);
      if (init?.method === "POST") {
        posts.push(url);
        return Response.json({ approval: { ...pending, status: "approved" } });
      }
      if (url.startsWith("/api/approvals")) {
        return Response.json({ approvals: rows, pending: rows.length });
      }
      throw new Error(`unexpected ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  return posts;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A router, because a request asked in a conversation links back to it.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ApprovalsList /> }),
    history: createMemoryHistory({ initialEntries: ["/approvals"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a waiting request shows who asked, for whom, and what it would change", async () => {
  serve([pending]);
  const view = draw();
  expect(await view.findByText("Ana · for Ben")).toBeTruthy();
  expect(view.getByText("Delete Ben's weekly report routine")).toBeTruthy();
  expect(view.getByRole("button", { name: "Approve" })).toBeTruthy();
});

test("a held tool call shows its exact arguments and a way back to the conversation", async () => {
  serve([heldCall]);
  const view = draw();
  expect(await view.findByText("Wants to use a tool")).toBeTruthy();
  expect(view.getByText("ana@example.test")).toBeTruthy();
  expect(view.getByText("The invoice is attached.")).toBeTruthy();
  const link = view.getByRole("link", { name: "Open the conversation" });
  expect(link.getAttribute("href")).toBe("/channel/ch-1");
});

test("every kind that needs the person is in one list, including chat cards (desk #69)", async () => {
  serve([pending, heldCall, chatCard]);
  const view = draw();
  const list = await view.findByRole("list", { name: "Requests" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(view.getByText("Asked you in a conversation")).toBeTruthy();
  expect(view.getByText("$128.40")).toBeTruthy();
  expect(view.queryByText("Nothing is waiting for you")).toBeNull();
  expect(view.getAllByRole("button", { name: "Approve" })).toHaveLength(3);
});

test("Approve sends that one decision and nothing is sent before it", async () => {
  const posts = serve([pending]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await view.findByText("Ana · for Ben");
  expect(posts).toEqual([]);
  await user.click(view.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(posts).toEqual(["/api/approvals/apr_1/approve"]));
});

test("Decline sends a rejection, for a chat card as for anything else", async () => {
  const posts = serve([chatCard]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Decline" }));
  await waitFor(() => expect(posts).toEqual(["/api/approvals/apr_3/reject"]));
});

test("with nothing waiting it says so, and offers no buttons", async () => {
  serve([]);
  const view = draw();
  expect(await view.findByText("Nothing is waiting for you")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
});
