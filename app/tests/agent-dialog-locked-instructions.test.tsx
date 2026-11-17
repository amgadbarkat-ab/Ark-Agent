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
import { queryClient as appQueryClient } from "@/query-client";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import { readInstructionProposalFile } from "../../shared/instruction-proposal";

/**
 * A trial employee's standing instruction on the General page (#116, item 2): read-only when the
 * signed profile owns it, with "Propose a change" for an administrator, which makes a file and
 * changes nothing. The customer's own employees still edit as before.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
// Lets the dialog's other reads settle before the window is taken away from under them.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 100)));

const CURRENT = "You are the front desk. Never give medical advice.";

let updates: Record<string, unknown>[] = [];
beforeEach(() => {
  updates = [];
  // The trial and the signed-in person are read through the app's one client; start each clean.
  appQueryClient.clear();
});

function serve({ locked, role }: { locked: boolean; role: "admin" | "user" }) {
  const actor = { id: "owner", email: "owner@example.test", role };
  const profile: AgentProfile = {
    id: "agent-front-desk",
    runLocation: "device",
    name: "Front Desk",
    title: "Front Desk",
    roleDescription: "Answers enquiries.",
    avatarSeed: "agent-front-desk",
    avatarImage: null,
    persona: CURRENT,
    primary: false,
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
      return { ...profile, ...value };
    },
  } as unknown as AgentProfileStore;
  const routes = createAgentRoutes(store, async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (path === "/api/me") return Response.json({ user: actor });
      if (path === "/api/trial") {
        return Response.json({
          trial: null,
          keyConfigured: true,
          lockedEmployees: locked
            ? [{ key: "front-desk", agentId: "agent-front-desk" }]
            : [],
          appVersion: "0.1.47",
        });
      }
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
        <AgentDialog agentId="agent-front-desk" onClose={() => {}} open />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a profile employee's instruction is shown read-only, and an administrator's proposal is a file that changes nothing", async () => {
  serve({ locked: true, role: "admin" });
  const saved: { name: string; blob: Blob }[] = [];
  const createObjectURL = URL.createObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  let lastBlob: Blob | undefined;
  URL.createObjectURL = (blob: Blob) => {
    lastBlob = blob;
    return "blob:proposal";
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (lastBlob) saved.push({ name: this.download, blob: lastBlob });
  };
  try {
    const view = draw();
    const user = userEvent.setup({ document: view.baseElement.ownerDocument });
    expect(
      await view.findByText("Set by BlackArk", { exact: false }),
    ).toBeTruthy();
    expect(view.getByText(CURRENT)).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Edit instructions" }),
    ).toBeNull();
    expect(view.queryByRole("button", { name: "Edit role" })).toBeNull();
    // The name is not the profile's to keep: it still edits.
    expect(view.getByRole("button", { name: "Edit name" })).toBeTruthy();

    await user.click(view.getByRole("button", { name: "Propose a change" }));
    const download = await view.findByRole("button", {
      name: "Download the file",
    });
    // Nothing changed yet and no reason given: nothing to send.
    expect(download.hasAttribute("disabled")).toBe(true);
    const proposed = view.getByLabelText("Proposed instruction");
    await user.clear(proposed);
    await user.type(proposed, `${CURRENT} Always ask for the appointment.`);
    await user.type(
      view.getByLabelText("Why"),
      "Callers forget to say which appointment.",
    );
    await user.click(download);

    expect(await view.findByText("The file is ready")).toBeTruthy();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toMatch(
      /^proposed-change-front-desk-\d{4}-\d{2}-\d{2}-\d{4}\.json$/,
    );
    const proposal = readInstructionProposalFile(
      (await saved[0]?.blob.text()) ?? "",
    );
    expect(proposal).toMatchObject({
      v: 1,
      employee: { id: "front-desk", name: "Front Desk" },
      current: CURRENT,
      proposed: `${CURRENT} Always ask for the appointment.`,
      reason: "Callers forget to say which appointment.",
      appVersion: "0.1.47",
    });
    // Nothing on this computer changed.
    expect(updates).toEqual([]);
  } finally {
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = click;
  }
});

test("only an administrator is offered Propose a change", async () => {
  serve({ locked: true, role: "user" });
  const view = draw();
  expect(
    await view.findByText("Set by BlackArk", { exact: false }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Propose a change" })).toBeNull();
  expect(view.queryByRole("button", { name: "Edit instructions" })).toBeNull();
});

test("the customer's own employee edits its instructions as before", async () => {
  serve({ locked: false, role: "admin" });
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: "Edit instructions" }),
  );
  expect(view.queryByRole("button", { name: "Propose a change" })).toBeNull();
  const field = view.getByDisplayValue(CURRENT);
  await user.clear(field);
  await user.type(field, "Sort the post.");
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(updates).toHaveLength(1));
  expect(updates[0]).toMatchObject({ persona: "Sort the post." });
});
