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
import { ActivationForm } from "@/components/activation/activation-form";
import { queryClient as appQueryClient } from "@/query-client";
import { Route as PlanRoute } from "@/routes/_authed/settings/plan";

/**
 * v0.1.50 (Amgad, 16 and 19 Nov): one release for everyone, and nothing trial- or customer-specific
 * on a screen. The trial's customer and the profile import are not shown; a profile is loaded by
 * BlackArk staff from the import folder in the setup session (docs/trials/README.md). The Activate
 * box and the plan, with its days left, are the same for everybody and stay.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  appQueryClient.clear();
});

const SLOW = { timeout: 5000 };
const CUSTOMER = "Wine Cellar Demo";

const trial = {
  customerId: "wine-cellar-demo",
  customerName: CUSTOMER,
  status: "trial",
  startsAt: "2026-11-16T00:00:00.000Z",
  endsAt: "2026-12-16T00:00:00.000Z",
  lengthDays: 30,
  daysLeft: 12,
  planId: "team",
  planName: "Ark Team",
  createBlocked: false,
  rosterSize: 3,
  checkInHost: null,
  lastCheckInAt: null,
  lastCheckInError: null,
};

const activation = {
  required: true,
  allowed: true,
  state: "trial",
  source: "trial-profile",
  customerId: "wine-cellar-demo",
  customerName: CUSTOMER,
  planId: "team",
  planName: "Ark Team",
  until: "2026-12-16T00:00:00.000Z",
  daysLeft: 12,
  seats: null,
  addons: [],
  renewHost: null,
  lastRenewAt: null,
  lastRenewError: null,
  keys: { trial: true, license: true },
};

function serve(withTrial: boolean) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/me"))
      return Response.json({
        user: { id: "u1", role: "admin", name: "Owner", email: "o@x.test" },
      });
    if (url.endsWith("/api/trial"))
      return Response.json({
        trial: withTrial ? trial : null,
        keyConfigured: true,
        lockedEmployees: [],
      });
    if (url.endsWith("/api/activation")) return Response.json({ activation });
    if (url.endsWith("/api/account"))
      return Response.json({
        account: {
          tenantId: "t1",
          tenantName: "owner@example.com",
          planId: "team",
          planName: "Ark Team",
          subscriptionStatus: "trialing",
          maxActiveBots: 15,
          canRun: true,
          activeBots: 3,
          currentPeriodEnd: "2026-12-16T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        billing: { mode: "internal", provider: null, selfService: false },
        plans: [],
      });
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderPlan() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: PlanRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function offersNoImport(screen: ReturnType<typeof render>) {
  const text = screen.container.textContent ?? "";
  expect(text).not.toContain(CUSTOMER);
  expect(text).not.toMatch(/import trial profile|\.arktrial|setup file/i);
  expect(screen.container.querySelector('input[type="file"]')).toBeNull();
}

test("Settings, then Plan, shows the trial's days left to an administrator, and never its customer or an import", async () => {
  serve(true);
  const screen = renderPlan();
  expect(await screen.findByText("12 days left.", {}, SLOW)).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: /Trial activation code/ }),
  ).toBeTruthy();
  offersNoImport(screen);
});

test("with no trial, Settings, then Plan, has no trial section to import one into", async () => {
  serve(false);
  const screen = renderPlan();
  expect(
    await screen.findByRole("textbox", { name: /Trial activation code/ }, SLOW),
  ).toBeTruthy();
  expect(screen.queryByText("Trial")).toBeNull();
  offersNoImport(screen);
});

test("the Activate screen's box takes a code or key, and offers no trial file", () => {
  const screen = render(
    <QueryClientProvider client={appQueryClient}>
      <ActivationForm />
    </QueryClientProvider>,
  );
  expect(
    screen.getByLabelText("Trial activation code or licence key"),
  ).toBeTruthy();
  offersNoImport(screen);
});
