import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { AgentDialog } from "@/components/agents/agent-dialog";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";

/**
 * What leads a person's team, and what a digital employee is told to do.
 *
 * Two things on the General page: which employee is primary, and the long instruction it works from.
 * The routes are the server's own, as in `agent-dialog-run-location.test.tsx`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** What `scripts/start.sh` sets `MANAGED_AGENT_AG_UI_URL` to. */
const MANAGED = "http://localhost:4201/ag-ui";

const actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user" as const,
};

/** Every update the store was asked to make, as the route parsed it. */
let updates: Record<string, unknown>[] = [];

beforeEach(() => {
  updates = [];
});

// Lets the dialog's other reads settle before the window is taken away from under them.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 100)));

let setPrimaryCalls = 0;

function serve(primary: boolean) {
  let profile: AgentProfile = {
    id: "expenses",
    runLocation: "cloud",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    avatarImage: null,
    persona: "Be careful with money.",
    primary,
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: "https://agents.example.test/ag-ui",
    hasAuth: false,
    hasCallbackToken: false,
  };
  const store = {
    get: async () => profile,
    update: async (_actor: unknown, _id: string, value: object) => {
      updates.push({ ...value });
      profile = { ...profile, ...value } as AgentProfile;
      return profile;
    },
    setPrimary: async () => {
      setPrimaryCalls += 1;
      profile = { ...profile, primary: true };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createAgentRoutes(
    store,
    auth,
    false,
    undefined,
    new Set(),
    undefined,
    true,
    MANAGED,
  );
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path === "/api/account/cloud") {
        return Response.json({
          cloud: { hosted: false, mode: "included", addOn: false },
          charges: [],
          limits: {},
        });
      }
      if (typeof path !== "string" || !path.startsWith("/api/agents/")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <AgentDialog agentId="expenses" onClose={() => {}} open />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the owner sees the instructions and can change them without touching the role", async () => {
  serve(false);
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  expect(await view.findByText("Be careful with money.")).toBeTruthy();
  await user.click(
    await view.findByRole("button", { name: "Edit instructions" }),
  );
  const field = view.getByDisplayValue("Be careful with money.");
  await user.clear(field);
  await user.type(field, "Always cite the receipt.");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({
    persona: "Always cite the receipt.",
    roleDescription: "Review receipts.",
  });
});

test("a digital employee that is not the lead can be made the lead", async () => {
  serve(false);
  setPrimaryCalls = 0;
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Make primary" }));
  await waitFor(() => expect(setPrimaryCalls).toBe(1));
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Make primary" })).toBeNull(),
  );
  expect(view.getByText("Leads your team.", { exact: false })).toBeTruthy();
});

test("the lead is shown as the lead and offers no button", async () => {
  serve(true);
  const view = draw();
  expect(
    await view.findByText("Leads your team.", { exact: false }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Make primary" })).toBeNull();
});
