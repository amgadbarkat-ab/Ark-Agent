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
import type { AccountOverview } from "@/lib/account/queries";
import { Route as AccountsRoute } from "@/routes/_authed/admin/accounts";
import { Route as PlanRoute } from "@/routes/_authed/settings/plan";

/**
 * Two screens that carry money and access: the one a customer reads to know what they have and how to
 * change it, and the one our staff use to set it by hand. Held against a fake server.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

const plans = [
  {
    id: "agent",
    name: "ArkAgent",
    priceEurCents: 5000,
    maxActiveBots: 1,
    summary: "One digital employee.",
  },
  {
    id: "team",
    name: "Ark Team",
    priceEurCents: 10000,
    maxActiveBots: 15,
    summary: "Up to 15 at once.",
  },
  {
    id: "enterprise",
    name: "Ark Team Enterprise",
    priceEurCents: 25000,
    maxActiveBots: 500,
    summary: "Up to 500 at once.",
  },
];

function overview(
  over: Partial<AccountOverview["account"]> = {},
  billing: Partial<AccountOverview["billing"]> = {},
): AccountOverview {
  return {
    account: {
      tenantId: "t1",
      tenantName: "ann@example.com",
      planId: "agent",
      planName: "ArkAgent",
      subscriptionStatus: "active",
      maxActiveBots: 1,
      canRun: true,
      activeBots: 1,
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      ...over,
    },
    billing: {
      mode: "subscriptions",
      provider: "sandbox",
      selfService: true,
      ...billing,
    },
    plans,
  };
}

type Calls = Array<{ method: string; url: string; body?: unknown }>;

function serve(
  data: AccountOverview | "fail",
  options: { calls?: Calls; checkoutUrl?: string } = {},
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    options.calls?.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/account/plan")) {
      return Response.json({
        checkoutUrl: options.checkoutUrl ?? "https://pay.example/checkout",
      });
    }
    if (url.endsWith("/api/account/cancel"))
      return Response.json({ cancelAtPeriodEnd: true });
    if (url.endsWith("/api/account")) {
      return data === "fail"
        ? new Response(null, { status: 500 })
        : Response.json(data);
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderRoute(component: unknown, entry = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: component as never }),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const renderPlan = (entry = "/") =>
  renderRoute(PlanRoute.options.component, entry);

test("shows the plan, when it renews and how much of it is in use", async () => {
  serve(overview());
  const screen = renderPlan();
  expect(await screen.findByText("1 of 1 working now", {}, SLOW)).toBeTruthy();
  expect(screen.getByText(/Renews on/)).toBeTruthy();
  expect(screen.getAllByText("ArkAgent").length).toBeGreaterThan(0);
});

test("offers the three plans with their prices, and marks the one you have", async () => {
  serve(overview());
  const screen = renderPlan();
  expect(await screen.findByText("€100 a month", {}, SLOW)).toBeTruthy();
  expect(screen.getByText("€50 a month")).toBeTruthy();
  expect(screen.getByText("€250 a month")).toBeTruthy();
  // The plan you are on is marked, and cannot be chosen again.
  expect(screen.getByText("Your plan", { selector: "span" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Choose ArkAgent" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose Ark Team" })).toBeTruthy();
});

test("choosing a plan asks the server and sends the person to pay", async () => {
  const calls: Calls = [];
  serve(overview(), {
    calls,
    checkoutUrl: "https://pay.example/checkout?plan=team",
  });
  const assigned: string[] = [];
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign: (url: string) => assigned.push(url) },
  });
  try {
    const screen = renderPlan();
    const user = userEvent.setup({ document });
    await user.click(
      await screen.findByRole("button", { name: "Choose Ark Team" }, SLOW),
    );
    await waitFor(() =>
      expect(assigned).toEqual(["https://pay.example/checkout?plan=team"]),
    );
    expect(
      calls.find((c) => c.url.endsWith("/api/account/plan"))?.body,
    ).toEqual({ planId: "team" });
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("someone who has not chosen a plan is told to, rather than shown an error", async () => {
  serve(
    overview({
      canRun: false,
      blockedCode: "no_plan",
      blockedReason: "Choose a plan to start your digital employees.",
      subscriptionStatus: "incomplete",
      activeBots: 0,
      currentPeriodEnd: null,
    }),
  );
  const screen = renderPlan();
  expect(await screen.findByRole("status", {}, SLOW)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/choose a plan/i);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a suspended account says why, in the customer's words", async () => {
  serve(
    overview({
      canRun: false,
      blockedCode: "suspended",
      blockedReason: "This account is suspended: payment dispute",
    }),
  );
  const screen = renderPlan();
  await waitFor(
    () =>
      expect(screen.getAllByText(/payment dispute/).length).toBeGreaterThan(0),
    SLOW,
  );
});

test("a cancelled-but-running plan says when it ends and offers no second cancel", async () => {
  serve(overview({ cancelAtPeriodEnd: true }));
  const screen = renderPlan();
  expect(await screen.findByText(/Ends on/, {}, SLOW)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel plan" })).toBeNull();
});

test("cancelling asks first, then cancels", async () => {
  const calls: Calls = [];
  serve(overview(), { calls });
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: "Cancel plan" }, SLOW),
  );
  expect(calls.some((c) => c.url.endsWith("/api/account/cancel"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Cancel plan" }));
  await waitFor(() =>
    expect(calls.some((c) => c.url.endsWith("/api/account/cancel"))).toBe(true),
  );
});

test("without online payment the plans are shown but cannot be bought here", async () => {
  serve(overview({}, { provider: "manual", selfService: false }));
  const screen = renderPlan();
  const choose = await screen.findByRole(
    "button",
    { name: "Choose Ark Team" },
    SLOW,
  );
  expect((choose as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Contact us to start or change a plan/)).toBeTruthy();
});

test("a company's own deployment shows no plans to buy and no billing", async () => {
  serve(
    overview(
      {
        planId: "internal",
        planName: "Internal",
        maxActiveBots: null,
        activeBots: 3,
      },
      { mode: "internal", provider: "manual", selfService: false },
    ),
  );
  const screen = renderPlan();
  expect(
    await screen.findByText("3 working now, no limit", {}, SLOW),
  ).toBeTruthy();
  expect(screen.queryByText("Plans")).toBeNull();
  expect(screen.queryByRole("button", { name: /Choose/ })).toBeNull();
  expect(screen.queryByText("Billing")).toBeNull();
});

test("a failed load is an error, not an empty plan", async () => {
  serve("fail");
  const screen = renderPlan();
  expect(await screen.findByRole("alert", {}, SLOW)).toBeTruthy();
  expect(screen.queryByText("Your plan")).toBeNull();
});

/** Staff screen. */
const account = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  name: "ann@example.com",
  ownerEmail: "ann@example.com",
  planId: "agent",
  subscriptionStatus: "active",
  suspended: false,
  suspendedReason: null,
  activeBots: 1,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

function serveAdmin(rows: unknown[], calls: Calls = []) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (
      url.includes("/api/admin/accounts") &&
      (init?.method ?? "GET") === "GET"
    ) {
      return Response.json({ tenants: rows, nextCursor: null });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
}

test("staff see each account's owner, plan and usage", async () => {
  serveAdmin([
    account(),
    account({
      tenantId: "t2",
      ownerEmail: "bob@example.com",
      suspended: true,
      suspendedReason: "chargeback",
      activeBots: 0,
    }),
  ]);
  const screen = renderRoute(AccountsRoute.options.component);
  expect(await screen.findByText("ann@example.com", {}, SLOW)).toBeTruthy();
  expect(screen.getByText("bob@example.com")).toBeTruthy();
  expect(screen.getByText(/Suspended: chargeback/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
});

test("staff suspend only with a reason, and restore with one press", async () => {
  const calls: Calls = [];
  serveAdmin([account()], calls);
  const screen = renderRoute(AccountsRoute.options.component);
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: "Suspend" }, SLOW),
  );
  const confirm = screen.getByRole("button", { name: "Suspend" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText(/Reason for suspending/), "chargeback");
  await user.click(screen.getByRole("button", { name: "Suspend" }));
  await waitFor(() =>
    expect(
      calls.some((c) => c.url.endsWith("/api/admin/accounts/t1/suspend")),
    ).toBe(true),
  );
  expect(calls.find((c) => c.url.endsWith("/suspend"))?.body).toEqual({
    reason: "chargeback",
  });
});

test("staff can put an account on another plan", async () => {
  const calls: Calls = [];
  serveAdmin([account()], calls);
  const screen = renderRoute(AccountsRoute.options.component);
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole(
      "combobox",
      { name: /Plan for ann@example.com/ },
      SLOW,
    ),
  );
  await user.click(await screen.findByRole("option", { name: "Ark Team" }));
  await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  const put = calls.find((c) => c.method === "PUT");
  expect(put?.url).toContain("/api/admin/accounts/t1/plan");
  expect(put?.body).toEqual({ planId: "team" });
});

/** The account as a payment provider confirms it a moment later: each read answers the next one. */
function serveInSteps(
  steps: AccountOverview[],
  options: { planAnswer?: unknown; calls?: Calls } = {},
) {
  let read = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    options.calls?.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/account/plan")) {
      return Response.json(options.planAnswer ?? { changed: true });
    }
    if (url.endsWith("/api/account")) {
      const step = steps[Math.min(read, steps.length - 1)];
      read += 1;
      return Response.json(step);
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const notYet = () =>
  overview({
    canRun: false,
    blockedCode: "no_plan",
    blockedReason: "Choose a plan to start your digital employees.",
    subscriptionStatus: "incomplete",
    activeBots: 0,
    currentPeriodEnd: null,
  });

test("coming back from paying says the payment is being confirmed, and updates by itself", async () => {
  serveInSteps([
    notYet(),
    overview({
      planId: "team",
      planName: "Ark Team",
      maxActiveBots: 15,
      activeBots: 0,
    }),
  ]);
  const screen = renderPlan("/?paid=1");
  expect(
    await screen.findByText(/We are confirming your payment/, {}, SLOW),
  ).toBeTruthy();
  // It does not tell somebody who has just paid to choose a plan.
  expect(screen.queryByText(/Choose a plan to start/) === null).toBe(true);
  // And it asks again on its own, so nothing needs reloading.
  await waitFor(
    () => {
      expect(
        screen.queryByText(/We are confirming your payment/) === null,
      ).toBe(true);
      expect(screen.getAllByText("Ark Team").length).toBeGreaterThan(0);
    },
    { timeout: 8000 },
  );
}, 12000);

test("without having just paid, no plan is the ordinary invitation to choose one", async () => {
  serveInSteps([notYet()]);
  const screen = renderPlan("/");
  expect(await screen.findByRole("status", {}, SLOW)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/choose a plan/i);
  expect(screen.queryByText(/confirming your payment/) === null).toBe(true);
});

test("changing plan while subscribed does not send anyone to pay, and waits for the change", async () => {
  const calls: Calls = [];
  serveInSteps(
    [
      overview(),
      overview(),
      overview({
        planId: "team",
        planName: "Ark Team",
        maxActiveBots: 15,
        activeBots: 1,
      }),
    ],
    { calls },
  );
  const assigned: string[] = [];
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign: (url: string) => assigned.push(url) },
  });
  try {
    const screen = renderPlan();
    const user = userEvent.setup({ document });
    await user.click(
      await screen.findByRole("button", { name: "Choose Ark Team" }, SLOW),
    );
    expect(
      await screen.findByText(/Changing your plan/, {}, SLOW),
    ).toBeTruthy();
    expect(assigned).toEqual([]);
    expect(
      calls.find((c) => c.url.endsWith("/api/account/plan"))?.body,
    ).toEqual({ planId: "team" });
    await waitFor(
      () =>
        expect(screen.queryByText(/Changing your plan/) === null).toBe(true),
      { timeout: 8000 },
    );
    expect(screen.getAllByText("Ark Team").length).toBeGreaterThan(0);
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
}, 15000);
