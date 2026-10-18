import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalsList } from "@/components/approvals/approvals-list";

/**
 * The inbox: a request says who asked, what it would change and for whom; nothing happens until
 * Approve or Reject is pressed, and each press sends exactly that one decision.
 */

beforeAll(() => GlobalRegistrator.register());
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
  status: "pending",
  result: null,
  requestedBy: { id: "lead", name: "Ana" },
  target: { id: "ben", name: "Ben" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  decidedAt: null,
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
  return render(
    <QueryClientProvider client={client}>
      <ApprovalsList />
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

test("Approve sends that one decision and nothing is sent before it", async () => {
  const posts = serve([pending]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await view.findByText("Ana · for Ben");
  expect(posts).toEqual([]);
  await user.click(view.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(posts).toEqual(["/api/approvals/apr_1/approve"]));
});

test("Reject sends a rejection", async () => {
  const posts = serve([pending]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Reject" }));
  await waitFor(() => expect(posts).toEqual(["/api/approvals/apr_1/reject"]));
});

test("with nothing waiting it says so, and offers no buttons", async () => {
  serve([]);
  const view = draw();
  expect(await view.findByText("Nothing is waiting for you")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Approve" })).toBeNull();
});
