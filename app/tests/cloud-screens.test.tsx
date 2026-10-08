import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccountOverview } from "@/lib/account/queries";
import type {
  AdminCloudCharge,
  AdminCloudRates,
  AdminCloudUsage,
  CloudOverview,
  CloudRates,
} from "@/lib/cloud/queries";
import { Route as CloudAdminRoute } from "@/routes/_authed/admin/cloud";
import { Route as PlanRoute } from "@/routes/_authed/settings/plan";
import { queryClient } from "@/query-client";

/**
 * The two screens that put a price in front of somebody: the one a customer reads before agreeing to
 * pay for cloud running, and the one our staff set the price on. Held against a fake server.
 *
 * What matters: nobody can switch it on without ticking that they read the prices, the prices that
 * are sent are exactly the ones on the screen, a refusal because the prices moved shows the new ones
 * and asks again, and nothing about money appears on a deployment where nothing is charged.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
// The screens' writes invalidate the app's one client, so the screens are drawn with it, and it is
// emptied between tests so one test's answers are not the next one's.
afterEach(() => queryClient.clear());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const SLOW = { timeout: 5000 };

const RATES: CloudRates = {
  computeCentsPerHour: 60,
  storageCentsPerGbMonth: 0,
  egressCentsPerGb: 0,
  paymentFeePercent: 5,
  paymentFeeFixedCents: 50,
  marginPercent: 0,
  minimumChargeCents: 500,
};

const account: AccountOverview = {
  account: {
    tenantId: "t1",
    tenantName: "ann@example.com",
    planId: "team",
    planName: "Ark Team",
    subscriptionStatus: "active",
    maxActiveBots: 15,
    canRun: true,
    activeBots: 1,
    currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  },
  billing: { mode: "subscriptions", provider: "paddle", selfService: true },
  plans: [],
};

function cloud(
  over: Partial<CloudOverview["cloud"]> = {},
  charges: CloudOverview["charges"] = [],
): CloudOverview {
  return {
    cloud: {
      mode: "metered",
      hosted: true,
      addOn: true,
      priced: true,
      rates: RATES,
      enabled: false,
      ratesChanged: false,
      monthlyCapCents: 2000,
      defaultCapCents: 2000,
      period: "2026-10",
      usage: { computeSeconds: 0, storageByteSeconds: 0, egressBytes: 0 },
      hours: 0,
      usageLines: [],
      chargeSoFarCents: 0,
      nearCap: false,
      atCap: false,
      ...over,
    },
    charges,
    limits: { minCents: 100, maxCents: 1_000_000 },
  };
}

type Call = { method: string; url: string; body?: unknown };

/** A server whose cloud answer can be changed between requests, and which writes down what it was sent. */
function serve(
  state: { current: CloudOverview },
  options: {
    calls?: Call[];
    onEnable?: () => Response | undefined;
  } = {},
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    options.calls?.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/account/cloud/enable")) {
      return options.onEnable?.() ?? Response.json({});
    }
    if (url.endsWith("/api/account/cloud/cap")) return Response.json({});
    if (url.endsWith("/api/account/cloud/disable")) return Response.json({});
    if (url.endsWith("/api/account/cloud")) return Response.json(state.current);
    if (url.endsWith("/api/account")) return Response.json(account);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderRoute(component: unknown) {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree: createRootRoute({ component: component as never }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}
const renderPlan = () => renderRoute(PlanRoute.options.component);

test("a deployment where cloud running is not an add-on says nothing about it", async () => {
  serve({ current: cloud({ addOn: false, mode: "included" }) });
  const screen = renderPlan();
  expect(await screen.findByText("Your plan", {}, SLOW)).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Cloud running")).toBeNull());
  expect(screen.queryByText(/Ark's cloud/)).toBeNull();
});

test("before anything is priced it says so, and offers no way to switch it on", async () => {
  serve({ current: cloud({ priced: false, rates: null }) });
  const screen = renderPlan();
  expect(await screen.findByText(/Not available yet/, {}, SLOW)).toBeTruthy();
});

test("the prices are shown in plain words before anybody agrees to them", async () => {
  serve({ current: cloud() });
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  expect(
    await screen.findByText(/for each hour a coworker is working/, {}, SLOW),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Run in Ark's cloud/ }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("An hour of a coworker working"),
  ).toBeTruthy();
  expect(within(dialog).getByText("€0.60")).toBeTruthy();
  // The fee is shown as the fee, with its fixed part.
  expect(within(dialog).getByText("5% + €0.50")).toBeTruthy();
  // Storage and egress are not charged at these rates, so they are not listed as if they were.
  expect(within(dialog).queryByText(/gigabyte/)).toBeNull();
  // No margin is claimed when there is none.
  expect(within(dialog).queryByText(/on top of the cost/)).toBeNull();
});

test("it cannot be switched on until the person says they read the prices, and then sends exactly those prices and their limit", async () => {
  const calls: Call[] = [];
  const state = { current: cloud() };
  serve(state, { calls });
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: /Run in Ark's cloud/ }, SLOW),
  );
  const dialog = await screen.findByRole("dialog");
  const on = within(dialog).getByRole("button", { name: "Switch on" });
  expect((on as HTMLButtonElement).disabled).toBe(true);

  await user.click(within(dialog).getByRole("checkbox"));
  expect((on as HTMLButtonElement).disabled).toBe(false);

  const limit = within(dialog).getByLabelText(/Most to spend/);
  await user.clear(limit);
  await user.type(limit, "35.50");
  await user.click(on);
  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/cloud/enable"))).toBe(true),
  );
  expect(
    calls.find((call) => call.url.endsWith("/cloud/enable")),
  ).toMatchObject({
    method: "POST",
    body: { monthlyCapCents: 3550, shownRates: RATES },
  });
});

test("a limit that is not an amount of euros in range is refused on the screen", async () => {
  serve({ current: cloud() });
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: /Run in Ark's cloud/ }, SLOW),
  );
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("checkbox"));
  const limit = within(dialog).getByLabelText(/Most to spend/);
  for (const typed of ["0.5", "lots", "20000", "12.345"]) {
    await user.clear(limit);
    await user.type(limit, typed);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Switch on",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(within(dialog).getByRole("alert").textContent).toMatch(/between/);
  }
});

test("when the prices moved, the new ones are shown and the agreement has to be given again", async () => {
  const state = { current: cloud() };
  serve(state, {
    onEnable: () => {
      // Staff set a new price while the person was reading.
      state.current = cloud({
        rates: { ...RATES, computeCentsPerHour: 90 },
      });
      return Response.json(
        {
          error: "The prices changed while you were looking. Read them again.",
        },
        { status: 409 },
      );
    },
  });
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: /Run in Ark's cloud/ }, SLOW),
  );
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(within(dialog).getByRole("button", { name: "Switch on" }));

  expect(
    await within(dialog).findByText(
      /prices changed while you were looking/,
      {},
      SLOW,
    ),
  ).toBeTruthy();
  expect(await within(dialog).findByText("€0.90", {}, SLOW)).toBeTruthy();
  // What was ticked was the old prices. It is not carried over to the new ones.
  expect(
    (within(dialog).getByRole("checkbox") as HTMLInputElement).getAttribute(
      "aria-checked",
    ),
  ).not.toBe("true");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Switch on",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("when it is on, it shows the month so far against the limit, and the months charged", async () => {
  serve({
    current: cloud(
      {
        enabled: true,
        monthlyCapCents: 2000,
        hours: 12.5,
        usageLines: ["12.50 hours of running"],
        chargeSoFarCents: 840,
      },
      [
        {
          id: "c1",
          period: "2026-09",
          status: "charged",
          amountCents: 1230,
          usageLines: ["18.00 hours of running"],
        },
        {
          id: "c2",
          period: "2026-08",
          status: "checking",
          amountCents: 500,
          usageLines: [],
        },
        {
          id: "c3",
          period: "2026-07",
          status: "carried",
          amountCents: 0,
          usageLines: [],
        },
      ],
    ),
  });
  const screen = renderPlan();
  expect(
    await screen.findByText(/On\. Up to €20 a month/, {}, SLOW),
  ).toBeTruthy();
  expect(screen.getByText("October 2026")).toBeTruthy();
  expect(screen.getByText("12.50 hours of running")).toBeTruthy();
  expect(screen.getByText("€8.40 of €20")).toBeTruthy();
  expect(screen.getByText("September 2026")).toBeTruthy();
  expect(screen.getByText("€12.30")).toBeTruthy();
  expect(
    screen.getByText(/Being confirmed with the payment service/),
  ).toBeTruthy();
  expect(screen.getByText(/added to the next month/)).toBeTruthy();
});

test("when the prices changed under a switch that is on, it says runs are paused and asks for the new agreement", async () => {
  const calls: Call[] = [];
  const newer = { ...RATES, computeCentsPerHour: 90 };
  serve(
    { current: cloud({ enabled: true, ratesChanged: true, rates: newer }) },
    { calls },
  );
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  expect(
    await screen.findByText(
      /The prices changed\. Cloud runs are paused/,
      {},
      SLOW,
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Run in Ark's cloud/ }));
  const dialog = await screen.findByRole("dialog");
  // The new prices are what is shown, and they have to be agreed to; the limit cannot be saved
  // around them.
  expect(within(dialog).getByText("€0.90")).toBeTruthy();
  expect(
    within(dialog).queryByRole("button", { name: "Save limit" }),
  ).toBeNull();
  const agree = within(dialog).getByRole("button", {
    name: "Agree to the new prices",
  });
  expect((agree as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(agree);
  await waitFor(() =>
    expect(
      calls.find((call) => call.url.endsWith("/cloud/enable")),
    ).toMatchObject({
      body: { monthlyCapCents: 2000, shownRates: newer },
    }),
  );
});

test("at the limit it says that no more cloud runs will start", async () => {
  serve({
    current: cloud({
      enabled: true,
      atCap: true,
      nearCap: true,
      chargeSoFarCents: 2000,
    }),
  });
  const screen = renderPlan();
  expect(
    await screen.findByText(
      /The limit is reached, so no more cloud runs start/,
      {},
      SLOW,
    ),
  ).toBeTruthy();
});

test("the limit can be changed and cloud running switched off", async () => {
  const calls: Call[] = [];
  serve(
    { current: cloud({ enabled: true, monthlyCapCents: 2000 }) },
    { calls },
  );
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: /Run in Ark's cloud/ }, SLOW),
  );
  const dialog = await screen.findByRole("dialog");
  const save = within(dialog).getByRole("button", { name: "Save limit" });
  // Unchanged is not a change.
  expect((save as HTMLButtonElement).disabled).toBe(true);
  const limit = within(dialog).getByLabelText(/Most to spend/);
  await user.clear(limit);
  await user.type(limit, "50");
  await user.click(save);
  await waitFor(() =>
    expect(calls.find((call) => call.url.endsWith("/cloud/cap"))).toMatchObject(
      {
        method: "PUT",
        body: { monthlyCapCents: 5000 },
      },
    ),
  );
});

test("switching off is one click and sends nothing else", async () => {
  const calls: Call[] = [];
  serve({ current: cloud({ enabled: true }) }, { calls });
  const screen = renderPlan();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: /Run in Ark's cloud/ }, SLOW),
  );
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Switch off" }));
  await waitFor(() =>
    expect(
      calls.find((call) => call.url.endsWith("/cloud/disable")),
    ).toMatchObject({
      method: "POST",
    }),
  );
});

/* ---------------------------------------------------------------- staff */

const adminRates = (rates: CloudRates | null): AdminCloudRates => ({
  mode: "metered",
  rates,
  limits: {
    computeCentsPerHour: 10_000,
    storageCentsPerGbMonth: 10_000,
    egressCentsPerGb: 10_000,
    paymentFeePercent: 50,
    paymentFeeFixedCents: 1_000,
    marginPercent: 1_000,
    minimumChargeCents: 100_000,
  },
});

const usage: AdminCloudUsage = {
  period: "2026-10",
  priced: true,
  totals: { hours: 30, costCents: 1800, chargeCents: 2003 },
  accounts: [
    {
      tenantId: "t1",
      name: "ann@example.com",
      enabled: true,
      hours: 20,
      usageLines: ["20.00 hours of running"],
      costCents: 1200,
      chargeCents: 1329,
    },
  ],
};

function charge(over: Partial<AdminCloudCharge>): AdminCloudCharge {
  return {
    id: "c1",
    tenantId: "t1",
    tenantName: "ann@example.com",
    period: "2026-09",
    status: "charged",
    costCents: 1000,
    amountCents: 1100,
    note: null,
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...over,
  };
}

function serveAdmin(
  options: {
    rates?: CloudRates | null;
    charges?: AdminCloudCharge[];
    calls?: Call[];
  } = {},
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    options.calls?.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/admin/cloud/rates")) {
      return method === "PUT"
        ? Response.json({})
        : Response.json(
            adminRates(options.rates === undefined ? RATES : options.rates),
          );
    }
    if (url.includes("/api/admin/cloud/usage")) return Response.json(usage);
    if (url.includes("/api/admin/cloud/charges") && method === "GET") {
      return Response.json({ charges: options.charges ?? [] });
    }
    if (url.includes("/settle")) return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}
const renderAdmin = () => renderRoute(CloudAdminRoute.options.component);

test("staff see the prices, what each account used and what it cost", async () => {
  serveAdmin();
  const screen = renderAdmin();
  expect(
    await screen.findByText(
      /€0\.60 an hour, 5% payment fee, 0% margin/,
      {},
      SLOW,
    ),
  ).toBeTruthy();
  expect(await screen.findByText("ann@example.com", {}, SLOW)).toBeTruthy();
  expect(screen.getByText(/20\.00 hours of running/)).toBeTruthy();
  expect(screen.getByText("cost €12")).toBeTruthy();
});

test("with no prices set, staff are told nothing can be charged", async () => {
  serveAdmin({ rates: null });
  const screen = renderAdmin();
  expect(
    await screen.findByText(/Not set\. Until they are/, {}, SLOW),
  ).toBeTruthy();
});

test("staff set prices from numbers, and a nonsense number cannot be saved", async () => {
  const calls: Call[] = [];
  serveAdmin({ calls });
  const screen = renderAdmin();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole(
      "button",
      { name: /Prices for cloud running/ },
      SLOW,
    ),
  );
  const dialog = await screen.findByRole("dialog");
  const running = within(dialog).getByLabelText(/Running/);
  await user.clear(running);
  await user.type(running, "75");
  const save = within(dialog).getByRole("button", { name: "Save prices" });
  expect((save as HTMLButtonElement).disabled).toBe(false);

  const fee = within(dialog).getByLabelText(/Payment fee \(percent\)/);
  await user.clear(fee);
  await user.type(fee, "80");
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByRole("alert").textContent).toMatch(/0 to 50/);
  await user.clear(fee);
  await user.type(fee, "5");

  await user.click(save);
  await waitFor(() =>
    expect(
      calls.find(
        (call) => call.url.endsWith("/rates") && call.method === "PUT",
      ),
    ).toMatchObject({ body: { ...RATES, computeCentsPerHour: 75 } }),
  );
});

test("an unanswered charge can be recorded as charged only with a note, and says what it is doing", async () => {
  const calls: Call[] = [];
  serveAdmin({
    calls,
    charges: [
      charge({ id: "u1", status: "uncertain", tenantName: "bob@example.com" }),
      charge({ id: "ok1", status: "charged", period: "2026-08" }),
    ],
  });
  const screen = renderAdmin();
  const user = userEvent.setup({ document });
  expect(await screen.findByText("bob@example.com", {}, SLOW)).toBeTruthy();
  expect(
    screen.getByText(/sent, the payment service did not say/),
  ).toBeTruthy();
  // A month already charged is shown, with no way to settle it again.
  expect(
    screen.getAllByRole("button", { name: "It was charged" }),
  ).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "It was charged" }));
  const confirm = screen.getByRole("button", { name: "Record as charged" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText("Where you saw it"), "Paddle, 2 Oct");
  await user.click(confirm);
  await waitFor(() =>
    expect(
      calls.find((call) => call.url.endsWith("/charges/u1/settle")),
    ).toMatchObject({
      method: "POST",
      body: { outcome: "charged", note: "Paddle, 2 Oct" },
    }),
  );
});
