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
import { OpenTeamChannelButton } from "@/components/agents/open-team-channel-button";

/** One press opens the team's channel; a team of one is told why not, in words. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function serve(answer: () => Response) {
  const calls: { path: string; method?: string }[] = [];
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push({ path: String(path), method: init?.method });
      return answer();
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: OpenTeamChannelButton }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("pressing it asks the server for the team channel", async () => {
  const calls = serve(() =>
    Response.json({
      channel: { id: "channel-1", name: "Your team", agentIds: ["a", "b"] },
    }),
  );
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Team channel" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      path: "/api/channels/team",
      method: "POST",
    }),
  );
});

test("a team of one is told why there is no channel", async () => {
  serve(() =>
    Response.json(
      { error: "A team channel needs at least two digital employees." },
      { status: 409 },
    ),
  );
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Team channel" }));
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(
    view.getByText("A team channel needs at least two digital employees."),
  ).toBeTruthy();
});
