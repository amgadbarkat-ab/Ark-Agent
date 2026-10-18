import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoriesSection } from "@/components/agents/memories-section";

/** What a digital employee keeps in mind: the owner can read, add, correct and delete it. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Sent = { path: string; method?: string; body?: unknown };

function serve(rows: unknown[], refuse?: string) {
  const sent: Sent[] = [];
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const method = init?.method;
      if (method && method !== "GET") {
        sent.push({
          path: String(path),
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (refuse) return Response.json({ error: refuse }, { status: 400 });
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ memory: rows[0] ?? {} }, { status: 200 });
      }
      return Response.json({ memories: rows });
    },
    { preconnect: originalFetch.preconnect },
  );
  return sent;
}

const row = {
  id: "mem_1",
  content: "Prefers short answers.",
  source: "agent",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function draw(canManage = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoriesSection agentId="ana" canManage={canManage} />
    </QueryClientProvider>,
  );
}

test("shows what it keeps in mind and who put it there", async () => {
  serve([row]);
  const view = draw();
  expect(await view.findByText("Prefers short answers.")).toBeTruthy();
  expect(view.getByText("Kept by the digital employee")).toBeTruthy();
});

test("adding sends the text to that employee", async () => {
  const sent = serve([]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.type(await view.findByLabelText("New memory"), "Works in Athens.");
  await user.click(view.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/agents/ana/memories",
      method: "POST",
      body: { content: "Works in Athens." },
    }),
  );
});

test("correcting sends the new wording for that memory", async () => {
  const sent = serve([row]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: "Edit this memory" }),
  );
  const field = view.getByLabelText("Edit memory");
  await user.clear(field);
  await user.type(field, "Prefers long answers.");
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/agents/ana/memories/mem_1",
      method: "PATCH",
      body: { content: "Prefers long answers." },
    }),
  );
});

test("deleting removes that memory", async () => {
  const sent = serve([row]);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: "Delete this memory" }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/agents/ana/memories/mem_1",
      method: "DELETE",
      body: undefined,
    }),
  );
});

test("a refusal is shown in words", async () => {
  serve([], "That looks like a password, and those are never kept.");
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.type(await view.findByLabelText("New memory"), "x");
  await user.click(view.getByRole("button", { name: "Add" }));
  expect(
    await view.findByText(
      "That looks like a password, and those are never kept.",
    ),
  ).toBeTruthy();
});

test("somebody who cannot manage it can read it and change nothing", async () => {
  serve([row]);
  const view = draw(false);
  expect(await view.findByText("Prefers short answers.")).toBeTruthy();
  expect(view.queryByLabelText("New memory")).toBeNull();
  expect(view.queryByRole("button", { name: "Delete this memory" })).toBeNull();
});
