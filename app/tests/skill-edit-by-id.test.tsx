import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditSkill } from "@/components/skills/edit-skill";
import { queryClient } from "@/query-client";

/**
 * Two skills answer to `/standup` — the deployment's, and this person's own — and a link that says
 * only `standup` has to open the person's own. Whatever is saved or switched from there names the
 * skill by its id, never by the name, so it can only ever reach the one on screen.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterEach(() => queryClient.clear());
// The tests turn retrying off on the app's one client; it is put back so no other file inherits that.
const originalDefaults = queryClient.getDefaultOptions();
afterAll(() => queryClient.setDefaultOptions(originalDefaults));
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

const skill = (overrides: Record<string, unknown>) => ({
  id: "x",
  slug: "standup",
  ownerUserId: null,
  title: "Standup",
  summary: "",
  instructions: "",
  origin: "yours",
  installedBy: null,
  grantedTo: [] as string[],
  tools: [] as string[],
  ...overrides,
});

const skills = [
  skill({
    id: "sk_deployment",
    ownerUserId: null,
    instructions: "The house standup.",
  }),
  skill({
    id: "sk_mine",
    ownerUserId: "me",
    instructions: "My own standup.",
  }),
];

type Call = { method: string; url: string; body?: Record<string, unknown> };

function serve(calls: Call[]) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/me")) {
      return Response.json({
        user: { id: "me", email: "me@example.test", role: "user" },
      });
    }
    if (url.endsWith("/api/plugins")) {
      return Response.json({ catalogue: [], servers: [], skills });
    }
    if (url.endsWith("/api/agents")) {
      return Response.json({
        agents: [{ id: "bot-1", name: "Helper", mine: true }],
      });
    }
    return Response.json({ ok: true, skills: [] });
  }) as unknown as typeof fetch;
}

function renderEdit(reference: string) {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <EditSkill reference={reference} />,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a link by name opens the person's own skill, not the deployment's", async () => {
  serve([]);
  const screen = renderEdit("standup");
  expect(
    await screen.findByDisplayValue("My own standup.", {}, SLOW),
  ).toBeTruthy();
  expect(screen.queryByDisplayValue("The house standup.")).toBeNull();
});

test("a link by id opens exactly that skill", async () => {
  serve([]);
  const screen = renderEdit("sk_deployment");
  expect(
    await screen.findByDisplayValue("The house standup.", {}, SLOW),
  ).toBeTruthy();
});

test("saving sends the id of the skill on screen", async () => {
  const calls: Call[] = [];
  serve(calls);
  const screen = renderEdit("standup");
  const user = userEvent.setup({ document });
  await screen.findByDisplayValue("My own standup.", {}, SLOW);

  await user.click(screen.getByRole("button", { name: "Save changes" }));

  await expectCall(calls, (call) => call.method === "POST");
  const save = calls.find(
    (call) =>
      call.method === "POST" && call.url.endsWith("/api/plugins/skills"),
  );
  expect(save?.body?.id).toBe("sk_mine");
  expect(save?.body?.slug).toBe("standup");
});

test("putting it on a Bot names the skill by its id", async () => {
  const calls: Call[] = [];
  serve(calls);
  const screen = renderEdit("standup");
  const user = userEvent.setup({ document });
  await screen.findByDisplayValue("My own standup.", {}, SLOW);

  await user.click(await screen.findByRole("button", { name: "Helper" }));

  await expectCall(calls, (call) => call.url.endsWith("/api/plugins/grants"));
  const grant = calls.find((call) => call.url.endsWith("/api/plugins/grants"));
  expect(grant?.body).toEqual({
    kind: "skill",
    ref: "sk_mine",
    agentId: "bot-1",
  });
});

async function expectCall(calls: Call[], match: (call: Call) => boolean) {
  const start = Date.now();
  while (!calls.some(match)) {
    if (Date.now() - start > 5000) throw new Error("the call was never made");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
