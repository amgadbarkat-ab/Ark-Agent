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
 * Where a coworker runs, chosen on the coworker.
 *
 * Only on a hosted service with customers, where "on my own computer" means something, and only while
 * cloud running is not switched off. The pick writes straight away and sends only the place, so
 * nothing else on the profile moves with it. The routes are the server's own, as in
 * `agent-dialog-built-in-edit.test.tsx`; the cloud status is a stub.
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

type Cloud = {
  hosted: boolean;
  mode: "included" | "metered" | "off";
  addOn: boolean;
};

function serve(endpoint: string, cloud: Cloud) {
  let profile: AgentProfile = {
    id: "expenses",
    runLocation: "cloud",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    avatarImage: null,
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint,
    hasAuth: false,
    hasCallbackToken: false,
  };
  const store = {
    get: async () => profile,
    update: async (_actor: unknown, _id: string, value: object) => {
      updates.push({ ...value });
      const { endpoint: moved, ...rest } = value as { endpoint?: string };
      profile = { ...profile, ...rest, endpoint: moved ?? profile.endpoint };
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
  // Private hosts closed, as on a deployment that did not open them, and the managed Bot named.
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
        return Response.json({ cloud, charges: [], limits: {} });
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

async function rename(view: ReturnType<typeof draw>, to: string) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Edit name" }));
  const field = view.getByDisplayValue("Expenses");
  await user.clear(field);
  await user.type(field, to);
  await user.click(view.getByRole("button", { name: "Save" }));
}

test("on a hosted service it can be set to the person's own computer, and only the place is sent", async () => {
  serve("https://agents.example.test/ag-ui", {
    hosted: true,
    mode: "metered",
    addOn: true,
  });
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    await view.findByRole("combobox", { name: "Where it runs" }),
  );
  await user.click(await view.findByRole("option", { name: "My computer" }));

  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ runLocation: "device" });
});

test("renaming a coworker does not send a place, so it cannot move one", async () => {
  serve("https://agents.example.test/ag-ui", {
    hosted: true,
    mode: "metered",
    addOn: true,
  });
  const view = draw();
  await rename(view, "Receipts");
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ name: "Receipts" });
  expect(updates[0]?.runLocation).toBeUndefined();
});

test("on a company's own deployment there is no such choice", async () => {
  serve("https://agents.example.test/ag-ui", {
    hosted: false,
    mode: "included",
    addOn: false,
  });
  const view = draw();
  expect(await view.findByRole("button", { name: "Edit name" })).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByText("Where it runs")).toBeNull();
});

test("where cloud running is switched off there is no choice to make", async () => {
  serve("https://agents.example.test/ag-ui", {
    hosted: true,
    mode: "off",
    addOn: false,
  });
  const view = draw();
  expect(await view.findByRole("button", { name: "Edit name" })).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByText("Where it runs")).toBeNull();
});
