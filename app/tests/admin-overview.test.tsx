import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { AdminOverview } from "@/components/admin/overview";
import type { Overview } from "@/lib/overview/queries";
import { queryClient } from "@/query-client";

/**
 * The administrator's overview renders what the server counted, in the order the server gave it, and
 * only follows a link to a screen the app knows. Nothing here decides whether something is wrong.
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

const overview = (overrides: Partial<Overview> = {}): Overview => ({
  generatedAt: "2026-10-09T10:00:00.000Z",
  attention: [],
  customers: {
    accounts: 3,
    paying: 2,
    pastDue: 0,
    canceled: 0,
    suspended: 0,
    newLast7Days: 1,
    newLast30Days: 3,
    people: 3,
    newPeopleLast7Days: 1,
    byPlan: [
      { planId: "agent", name: "Ark Agent", priceEurCents: 5000, paying: 1 },
      { planId: "team", name: "Ark Team", priceEurCents: 10000, paying: 1 },
    ],
  },
  revenue: { monthlyRecurringCents: 15000 },
  now: { runs: 1, accounts: 1, queuedWork: 4 },
  cloud: null,
  checks: [],
  ...overrides,
});

function serve(body: Overview | { error: string }, status = 200) {
  global.fetch = (async () =>
    Response.json(body, { status })) as unknown as typeof fetch;
}

function renderOverview() {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AdminOverview /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("says so when nothing needs the administrator", async () => {
  serve(overview());
  const screen = renderOverview();
  expect(
    await screen.findByText("Nothing needs you right now.", {}, SLOW),
  ).toBeTruthy();
});

test("lists what needs a decision, linking only the screens the app knows", async () => {
  serve(
    overview({
      attention: [
        {
          id: "charges-uncertain",
          severity: "action",
          title: "Cloud charges need your decision",
          detail: "1 month where the payment service did not say.",
          to: "/admin/cloud",
        },
        {
          id: "work-gave-up",
          severity: "action",
          title: "Background jobs gave up",
          detail: "2 jobs ran out of attempts.",
          to: null,
        },
        {
          id: "odd",
          severity: "watch",
          title: "Something sent a path this app does not have",
          detail: "Not followed.",
          to: "https://elsewhere.example/phish",
        },
      ],
    }),
  );
  const screen = renderOverview();
  await screen.findByText("Cloud charges need your decision", {}, SLOW);

  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("href")).toBe("/admin/cloud");
  expect(
    within(links[0] as HTMLElement).getByText(
      "Cloud charges need your decision",
    ),
  ).toBeTruthy();
  // The other two are on screen, as plain rows with nowhere to go.
  expect(screen.getByText("Background jobs gave up")).toBeTruthy();
  expect(
    screen.getByText("Something sent a path this app does not have"),
  ).toBeTruthy();
  expect(document.querySelector('a[href*="elsewhere"]') === null).toBe(true);
});

test("shows the counts and the money the server worked out", async () => {
  serve(overview());
  const screen = renderOverview();
  await screen.findByText("Monthly recurring revenue", {}, SLOW);
  // €150 a month, from one Ark Agent at €50 and one Ark Team at €100.
  expect(screen.getByText("€150")).toBeTruthy();
  expect(screen.getByText("Paying customers, of 3 accounts")).toBeTruthy();
  expect(screen.getByText("Ark Agent 1, Ark Team 1")).toBeTruthy();
  expect(screen.getByText("1 run, 1 account")).toBeTruthy();
  expect(screen.getByText(/4 background jobs waiting for a turn/)).toBeTruthy();
});

test("shows cloud cost only where the deployment runs coworkers in the cloud", async () => {
  serve(overview());
  const without = renderOverview();
  await without.findByText("Monthly recurring revenue", {}, SLOW);
  expect(without.queryByText(/Cloud running in/) === null).toBe(true);
  cleanup();
  queryClient.clear();

  serve(
    overview({
      cloud: {
        mode: "metered",
        period: "2026-10",
        priced: false,
        accountsUsing: 2,
        hours: 12.5,
        costCents: 750,
        chargeCents: 0,
      },
    }),
  );
  const withCloud = renderOverview();
  await withCloud.findByText("Cloud running in 2026-10, cost to us", {}, SLOW);
  expect(withCloud.getByText("€7.50")).toBeTruthy();
  expect(
    withCloud.getByText(/No prices are set yet, so nothing is charged/),
  ).toBeTruthy();
});

test("puts what is still to do before what is done, and says which is which", async () => {
  serve(
    overview({
      checks: [
        {
          id: "https",
          title: "Public address",
          state: "ok",
          detail: "Served over HTTPS.",
        },
        {
          id: "terms",
          title: "Terms of service",
          state: "todo",
          detail: "Not required yet.",
        },
        {
          id: "payments",
          title: "Payments",
          state: "info",
          detail: "Runs for one company.",
        },
      ],
    }),
  );
  const screen = renderOverview();
  await screen.findByText("Terms of service", {}, SLOW);
  const titles = ["Terms of service", "Payments", "Public address"].map(
    (title) => screen.getByText(title),
  );
  const position = (el: HTMLElement) =>
    Array.from(document.querySelectorAll("*")).indexOf(el);
  expect(position(titles[0] as HTMLElement)).toBeLessThan(
    position(titles[1] as HTMLElement),
  );
  expect(position(titles[1] as HTMLElement)).toBeLessThan(
    position(titles[2] as HTMLElement),
  );
  expect(screen.getByText("To do")).toBeTruthy();
  expect(screen.getByText("Your choice")).toBeTruthy();
  expect(screen.getByText("Done")).toBeTruthy();
  expect(screen.getByText(/1 thing is still to settle/)).toBeTruthy();
});

test("says it could not load rather than showing an empty overview", async () => {
  serve({ error: "No." }, 500);
  const screen = renderOverview();
  const alert = await screen.findByRole("alert", {}, SLOW);
  expect(alert.textContent).toBe("Could not load the overview.");
  expect(screen.queryByText("Nothing needs you right now.") === null).toBe(
    true,
  );
});
