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
import { PrioritySupportSection } from "@/components/settings/priority-support-section";

/**
 * 24/7 Priority Support (Amgad, 24 Nov 2026): any customer sees the offer, in BlackArk's words, with
 * "excl. VAT", can order it through BlackArk's checkout, and sees whether it is active.
 */

function inClient(node: React.ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  );
}

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  GlobalRegistrator.unregister();
});
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const SLOW = { timeout: 5000 };

const offer = {
  monthlyCents: 10000,
  vat: "excluded",
  scope: {
    el: "Υποστήριξη 24/7: απάντηση μέσα σε 1 ώρα, όλο το 24ωρο.",
    en: "24/7 support: response within 1 hour, around the clock, 7 days a week.",
  },
};
const BUY = "https://blackark.uk/checkin/buy/?customer=demo-shop&support=247";

function serve(body: unknown) {
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/api/support/priority")
      ? Response.json(body)
      : new Response(null, { status: 404 })) as unknown as typeof fetch;
}

test("not ordered: the offer, its price excl. VAT, and Order, which opens BlackArk's checkout", async () => {
  serve({ available: true, offer, plan: null, buyUrl: BUY, error: null });
  const screen = render(inClient(<PrioritySupportSection />));
  expect(await screen.findByText(/excl\. VAT/, {}, SLOW)).toBeTruthy();
  expect(screen.getByText(offer.scope.en)).toBeTruthy();
  expect(screen.getByText("Not active")).toBeTruthy();
  const order = screen.getByRole("button", { name: /Order 24\/7 support/ });
  expect(order.getAttribute("href")).toBe(BUY);
  expect(order.getAttribute("target")).toBe("_blank");
});

test("active: shown as active with the date paid to, and no Order button", async () => {
  serve({
    available: true,
    offer,
    plan: {
      status: "active",
      startedAt: "2026-11-24T10:00:00Z",
      paidUntil: "2026-12-24T10:00:00Z",
    },
    buyUrl: BUY,
    error: null,
  });
  const screen = render(inClient(<PrioritySupportSection />));
  expect(await screen.findByText(/^Active since/, {}, SLOW)).toBeTruthy();
  expect(screen.getByText(/^Paid until/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Order 24\/7 support/ }),
  ).toBeNull();
});

test("a failed renewal shows as not active, and it can be ordered again", async () => {
  serve({
    available: true,
    offer,
    plan: {
      status: "past_due",
      startedAt: "2026-11-24T10:00:00Z",
      paidUntil: null,
    },
    buyUrl: BUY,
    error: null,
  });
  const screen = render(inClient(<PrioritySupportSection />));
  expect(
    await screen.findByText(
      "Not active: the last payment did not go through.",
      {},
      SLOW,
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Order 24\/7 support/ }),
  ).toBeTruthy();
});

test("before activation: nothing to order yet, and it says why", async () => {
  serve({
    available: false,
    offer: null,
    plan: null,
    buyUrl: null,
    error: null,
  });
  const screen = render(inClient(<PrioritySupportSection />));
  expect(
    await screen.findByText(
      "Activate ArkAgent first to order 24/7 Priority Support.",
      {},
      SLOW,
    ),
  ).toBeTruthy();
});
