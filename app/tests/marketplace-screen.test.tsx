import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListingView } from "@/components/marketplace/listing-view";
import { ShareDialog } from "@/components/marketplace/share-dialog";
import type { ListingDetail } from "@/lib/marketplace/queries";
import { Route as ReviewRoute } from "@/routes/_authed/admin/marketplace";

/**
 * The marketplace's promise on screen: Ark's own digital employees can be installed, and another
 * person's shared coworker can only be read. The page says so in words, offers no way to install it,
 * and the share dialog refuses a secret and asks about anything merely private.
 *
 * Same harness as the other screens: `GlobalRegistrator` around the file, `cleanup` after each
 * test, and a client with `retry: false` so a failed read settles at once.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

const official: ListingDetail = {
  id: "o1",
  slug: "research-analyst",
  kind: "official",
  title: "Research Analyst",
  summary: "Finds and compares sources.",
  category: "research",
  tags: ["research"],
  publisher: { id: "ark", displayName: "Ark", official: true },
  installCount: 3,
  publishedAt: "2026-01-01T00:00:00Z",
  version: 1,
  description: "Works like a careful analyst.",
  content: {
    install: {
      name: "Research Analyst",
      title: "Research Analyst",
      roleDescription: "You are a careful research analyst.",
    },
    suggestedTools: ["Web search"],
  },
  mine: false,
  installedByMe: false,
};

const shared: ListingDetail = {
  ...official,
  id: "s1",
  slug: "careful-analyst-ab12cd",
  kind: "shared",
  title: "Careful analyst",
  summary: "Reads figures.",
  publisher: { id: "pub1", displayName: "Maya", official: false },
  installCount: 0,
  description: "How I set mine up.",
  content: {
    title: "Analyst",
    roleDescription: "Compares quarterly figures.",
    instructions: "Answer in two sentences.",
    tools: ["search_web"],
  },
  installedByMe: undefined,
};

type Call = { method: string; url: string; body: unknown };

/** A fake server: answers the paths it is given, records every call, refuses the rest. */
function serve(
  answers: Record<string, (call: Call) => Response>,
  calls: Call[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = answers[`${call.method} ${url}`];
    return answer ? answer(call) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

/** A router with the pages the screens link to, so a link has somewhere to point. */
function inRouter(node: React.ReactNode, initial = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const stub = (path: string) =>
    createRoute({
      path,
      getParentRoute: () => rootRoute,
      component: () => null,
    });
  const home = createRoute({
    path: "/",
    getParentRoute: () => rootRoute,
    component: () => node,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      home,
      stub("/marketplace"),
      stub("/marketplace/mine"),
      stub("/marketplace/$slug"),
      stub("/marketplace/publishers/$id"),
      stub("/agents"),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const back = {
  label: "Marketplace",
  linkProps: { to: "/marketplace" },
} as const;

test("an official digital employee shows what it starts with and can be installed", async () => {
  const calls = serve({
    "POST /api/marketplace/listings/research-analyst/install": () =>
      Response.json(
        { agentId: "a1", name: "Research Analyst" },
        { status: 201 },
      ),
  });
  const screen = inRouter(<ListingView backButton={back} listing={official} />);
  expect(
    await screen.findByText("Starts with this role", {}, SLOW),
  ).toBeTruthy();
  expect(screen.getByText("You are a careful research analyst.")).toBeTruthy();
  expect(screen.getByText("Web search")).toBeTruthy();
  expect(screen.queryByText("For reading only")).toBeNull();

  await userEvent
    .setup({ document })
    .click(screen.getByRole("button", { name: "Install" }));
  expect(
    await screen.findByText(/is now one of your agents/, {}, SLOW),
  ).toBeTruthy();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "POST /api/marketplace/listings/research-analyst/install",
  ]);
  expect(
    (screen.getByRole("link", { name: "Open it" }) as HTMLAnchorElement).href,
  ).toContain("/agents");
});

test("a shared coworker is for reading: no way to install it, and it says so", async () => {
  const screen = inRouter(<ListingView backButton={back} listing={shared} />);
  expect(await screen.findByText("For reading only", {}, SLOW)).toBeTruthy();
  expect(
    screen.getByText(/cannot be installed, copied or exported/),
  ).toBeTruthy();
  expect(screen.getByText("Compares quarterly figures.")).toBeTruthy();
  expect(screen.getByText("Answer in two sentences.")).toBeTruthy();
  expect(screen.getByText("search_web")).toBeTruthy();
  // Nothing on the page can make a coworker from it.
  expect(screen.queryByRole("button", { name: /Install/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Copy|Export|Clone|Use/ }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: /Report/ })).toBeTruthy();
});

test("a person's own listing shows where it stands, and offers change and withdraw instead of report", async () => {
  const screen = inRouter(
    <ListingView
      backButton={back}
      listing={{
        ...shared,
        mine: true,
        status: "rejected",
        reviewNote: "Please say what it is for.",
      }}
    />,
  );
  expect(await screen.findByText("rejected", {}, SLOW)).toBeTruthy();
  expect(screen.getByText(/Please say what it is for\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Report/ })).toBeNull();
});

test("a report needs a reason, and is thanked once sent", async () => {
  const calls = serve({
    "POST /api/marketplace/listings/careful-analyst-ab12cd/report": () =>
      Response.json({ ok: true }, { status: 201 }),
  });
  const screen = inRouter(<ListingView backButton={back} listing={shared} />);
  const user = userEvent.setup({ document });
  await user.click(await screen.findByRole("button", { name: /Report/ }, SLOW));
  const send = await screen.findByRole("button", { name: "Send report" }, SLOW);
  expect((send as HTMLButtonElement).disabled).toBe(true);

  await user.click(screen.getByRole("combobox", { name: "What is wrong" }));
  await user.click(await screen.findByRole("option", { name: "Spam" }));
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  await user.click(send);
  expect(await screen.findByText("Thank you", {}, SLOW)).toBeTruthy();
  expect(calls.at(-1)?.body).toEqual({ reason: "spam", details: "" });
});

const mineAnswer = () =>
  Response.json({
    publisher: { id: "pub", displayName: "Maya", official: false, bio: "" },
    listings: [],
  });

test("sharing a coworker with a secret in it is refused, and nothing offers to override it", async () => {
  serve({
    "GET /api/marketplace/mine": mineAnswer,
    "POST /api/marketplace/mine/listings": () =>
      Response.json(
        {
          error:
            "This contains a secret. Remove what is listed, then try again.",
          findings: [
            {
              kind: "api_key",
              field: "Role description",
              line: 2,
              message: "Role description, line 2, looks like an API key.",
              secret: true,
            },
          ],
        },
        { status: 422 },
      ),
  });
  const screen = inRouter(
    <ShareDialog
      agent={{ id: "agent-1", name: "Ledger", title: "Bookkeeper" }}
      onOpenChange={() => undefined}
      open
    />,
  );
  const user = userEvent.setup({ document });
  await user.type(
    await screen.findByLabelText("One line about what it does", {}, SLOW),
    "Keeps books.",
  );
  await user.click(screen.getByRole("button", { name: "Share" }));

  expect(
    await screen.findByText(
      "Role description, line 2, looks like an API key.",
      {},
      SLOW,
    ),
  ).toBeTruthy();
  expect(screen.getByText(/Fix these in the coworker itself/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("private details need the person to say they checked, then it is sent for review", async () => {
  let attempts = 0;
  const calls = serve({
    "GET /api/marketplace/mine": mineAnswer,
    "POST /api/marketplace/mine/listings": (call) => {
      attempts += 1;
      return (call.body as { confirmedNoPrivateData: boolean })
        .confirmedNoPrivateData
        ? Response.json({ listing: shared }, { status: 201 })
        : Response.json(
            {
              error:
                "This may contain private details. Check what is listed, and tick the box to say it is safe to share.",
              findings: [
                {
                  kind: "email",
                  field: "Role description",
                  line: 1,
                  message:
                    "Role description, line 1, contains an email address.",
                  secret: false,
                },
              ],
            },
            { status: 422 },
          );
    },
  });
  const screen = inRouter(
    <ShareDialog
      agent={{ id: "agent-1", name: "Ledger", title: "Bookkeeper" }}
      onOpenChange={() => undefined}
      open
    />,
  );
  const user = userEvent.setup({ document });
  await user.type(
    await screen.findByLabelText("One line about what it does", {}, SLOW),
    "Keeps books.",
  );
  await user.click(screen.getByRole("button", { name: "Share" }));

  const box = await screen.findByRole("checkbox", {}, SLOW);
  const share = screen.getByRole("button", {
    name: "Share",
  }) as HTMLButtonElement;
  expect(share.disabled).toBe(true);
  await user.click(box);
  await waitFor(() => expect(share.disabled).toBe(false));
  await user.click(share);

  expect(await screen.findByText("Sent for review", {}, SLOW)).toBeTruthy();
  expect(attempts).toBe(2);
  const sent = calls.filter((c) => c.method === "POST").map((c) => c.body);
  expect(sent[0]).toMatchObject({
    agentId: "agent-1",
    confirmedNoPrivateData: false,
  });
  expect(sent[1]).toMatchObject({
    agentId: "agent-1",
    confirmedNoPrivateData: true,
  });
});

test("someone with no public name is asked for one first, and it is saved before the listing", async () => {
  const calls = serve({
    "GET /api/marketplace/mine": () =>
      Response.json({ publisher: null, listings: [] }),
    "PUT /api/marketplace/mine/publisher": () =>
      Response.json({ publisher: {} }),
    "POST /api/marketplace/mine/listings": () =>
      Response.json({ listing: shared }, { status: 201 }),
  });
  const screen = inRouter(
    <ShareDialog
      agent={{ id: "agent-1", name: "Ledger", title: "Bookkeeper" }}
      onOpenChange={() => undefined}
      open
    />,
  );
  const user = userEvent.setup({ document });
  await user.type(
    await screen.findByLabelText("Your name in the marketplace", {}, SLOW),
    "Maya",
  );
  await user.type(
    screen.getByLabelText("One line about what it does"),
    "Keeps books.",
  );
  await user.click(screen.getByRole("button", { name: "Share" }));
  expect(await screen.findByText("Sent for review", {}, SLOW)).toBeTruthy();
  const writes = calls
    .filter((c) => c.method !== "GET")
    .map((c) => `${c.method} ${c.url}`);
  expect(writes).toEqual([
    "PUT /api/marketplace/mine/publisher",
    "POST /api/marketplace/mine/listings",
  ]);
});

test("staff see what a stranger would read, approve it, and have to say why to reject", async () => {
  const waiting = {
    ...shared,
    id: "s9",
    status: "pending" as const,
    mine: false,
  };
  const calls = serve({
    "GET /api/admin/marketplace/pending": () =>
      Response.json({ listings: [waiting], nextCursor: null }),
    "GET /api/admin/marketplace/reports": () =>
      Response.json({ reports: [], nextCursor: null }),
    "POST /api/admin/marketplace/listings/s9/approve": () =>
      Response.json({ ok: true }),
    "POST /api/admin/marketplace/listings/s9/reject": () =>
      Response.json({ ok: true }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: ReviewRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  expect(await screen.findByText("Careful analyst", {}, SLOW)).toBeTruthy();
  expect(screen.getByText(/Compares quarterly figures\./)).toBeTruthy();
  expect(screen.getByText(/Answer in two sentences\./)).toBeTruthy();
  expect(screen.getByText("No open reports.")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Reject" }));
  const confirm = screen
    .getAllByRole("button", { name: "Reject" })
    .at(-1) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await user.type(
    screen.getByLabelText("Reason for rejecting Careful analyst"),
    "Please say what it is for.",
  );
  await waitFor(() => expect(confirm.disabled).toBe(false));
  await user.click(confirm);
  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith("/s9/reject"))).toBe(true),
  );
  expect(calls.find((c) => c.url.endsWith("/s9/reject"))?.body).toEqual({
    note: "Please say what it is for.",
  });
});
