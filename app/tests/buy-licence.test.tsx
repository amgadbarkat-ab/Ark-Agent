import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BuyLicence,
  PaymentReceived,
} from "@/components/activation/buy-licence";
import type { Activation } from "@/lib/trial/queries";
import { queryClient } from "@/query-client";

/**
 * The buy button and the notice after payment (#109, v0.1.49): the button opens BlackArk's buy page
 * for this install's customer and tells the server, which then asks for the key every 20 seconds;
 * once the key has come in by itself, the app says so.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const BUY = "https://blackark.uk/checkin/buy/?customer=demo-shop";
const sent: { url: string; method: string }[] = [];
const opened: string[] = [];

function stub() {
  sent.length = 0;
  opened.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET" });
    return Response.json({ buyUrl: BUY });
  }) as unknown as typeof fetch;
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof window.open;
}

const activation = (over: Partial<Activation> = {}): Activation => ({
  required: true,
  allowed: true,
  state: "trial",
  source: "trial-profile",
  customerId: "demo-shop",
  customerName: "Demo Shop",
  planId: "team",
  planName: "Team",
  until: "2026-12-16T00:00:00.000Z",
  daysLeft: 27,
  seats: null,
  addons: [],
  renewHost: null,
  lastRenewAt: null,
  lastRenewError: null,
  keys: { trial: true, license: true },
  buyUrl: BUY,
  paymentReceivedAt: null,
  ...over,
});

const wrap = (node: React.ReactNode) => (
  <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
);

test("the buy button tells the server, opens the buy page for this customer, and says what happens next", async () => {
  stub();
  const user = userEvent.setup({ document });
  const screen = render(wrap(<BuyLicence activation={activation()} />));
  await user.click(screen.getByRole("button", { name: "Buy a licence" }));
  await waitFor(() => expect(opened).toEqual([BUY]));
  expect(sent[0]).toEqual({ url: "/api/activation/buying", method: "POST" });
  // and from now it reads the activation again by itself
  await waitFor(() =>
    expect(sent.some((r) => r.url === "/api/activation")).toBe(true),
  );
  expect(
    screen.getByText(
      "Waiting for your payment. ArkAgent unlocks by itself as soon as it is paid; nothing needs to be typed.",
    ),
  ).toBeTruthy();
});

test("no buy button when there is nothing to buy here", () => {
  stub();
  const screen = render(
    wrap(<BuyLicence activation={activation({ buyUrl: null })} />),
  );
  expect(screen.queryByRole("button", { name: "Buy a licence" })).toBeNull();
});

test("a key that came in by itself after payment is announced", () => {
  const screen = render(
    wrap(
      <PaymentReceived
        activation={activation({
          state: "paid",
          source: "license",
          buyUrl: null,
          paymentReceivedAt: "2026-11-19T08:00:00.000Z",
        })}
      />,
    ),
  );
  expect(
    screen
      .getByRole("status")
      .textContent?.includes("Payment received: ArkAgent is activated."),
  ).toBe(true);
});

test("and nothing is announced for a key typed by hand or a trial", () => {
  const screen = render(
    wrap(<PaymentReceived activation={activation({ state: "paid" })} />),
  );
  expect(screen.queryByRole("status")).toBeNull();
});
