import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatSummarySection } from "@/components/agents/chat-summary-section";

/**
 * Weekly summary, then chat cleanup (Amgad, 24 Nov 2026): on for a new employee; switching it off
 * shows Amgad's exact words first, and only then is it switched off.
 */

function inClient(node: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  );
}

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const SLOW = { timeout: 5000 };
const WARNING =
  "deactivating this function will affect the usage of your LLM model.";

function serve() {
  let enabled = true;
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "PUT")
      enabled = (JSON.parse(String(init?.body)) as { enabled: boolean })
        .enabled;
    return Response.json({
      enabled,
      isDefault: enabled,
      summary: "Facts: Maria runs Demo Shop.",
      summaryTokens: 8,
      summarisedAt: "2026-11-29T01:00:00.000Z",
      lastError: null,
      warning: WARNING,
    });
  }) as unknown as typeof fetch;
  return calls;
}

test("on by default; switching off shows Amgad's warning, and only 'Switch it off' saves it", async () => {
  const calls = serve();
  const screen = render(inClient(<ChatSummarySection agentId="agent-1" />));
  const toggle = await screen.findByRole(
    "switch",
    { name: "Weekly summary, then chat cleanup" },
    SLOW,
  );
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  // The person's time zone goes with the first read, for their own Sunday night.
  expect(calls[0]?.url).toMatch(/\/api\/chat-summary\/agent-1\?tz=/);

  const user = userEvent.setup({ document });
  await user.click(toggle);
  expect(await screen.findByText(WARNING, {}, SLOW)).toBeTruthy();
  // Keeping it on changes nothing.
  await user.click(screen.getByRole("button", { name: "Keep it on" }));
  expect(calls.some((call) => call.method === "PUT")).toBe(false);

  await user.click(toggle);
  await user.click(
    await screen.findByRole("button", { name: "Switch it off" }, SLOW),
  );
  expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
    enabled: false,
  });
});

test("the summary it starts from can be read", async () => {
  serve();
  const screen = render(inClient(<ChatSummarySection agentId="agent-1" />));
  expect(
    await screen.findByText("Facts: Maria runs Demo Shop.", {}, SLOW),
  ).toBeTruthy();
});
