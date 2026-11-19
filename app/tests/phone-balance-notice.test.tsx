import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  BLACKARK_RELAY_URL,
  PhoneBalanceNotice,
} from "@/components/settings/phone-line-section";

/**
 * v0.1.50 (#149, 19 Nov): a new phone line points at BlackArk's Cloudflare relay, and the balance
 * the relay passes on always offers 5 more hours, not only once it runs low.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const topUpUrl = "https://blackark.uk/checkin/buy/?topup=1&customer=demo-phone";

test("a new line connects to BlackArk's relay on Cloudflare Workers", () => {
  expect(BLACKARK_RELAY_URL).toBe(
    "https://blackark-phone.blackark.workers.dev",
  );
});

test("with balance left, the amount shows and 5 more hours can be bought", () => {
  const screen = render(
    <PhoneBalanceNotice
      balance={{
        balanceMils: 23_400,
        state: "ok",
        minutesLeftAtLeast: 168,
        topUpUrl,
        receivedAt: "2026-11-19T12:00:00.000Z",
      }}
    />,
  );
  expect(screen.getByText(/at least 168 minutes/)).toBeTruthy();
  const buy = screen.getByRole("button", { name: "Add 5 hours" });
  expect(buy.getAttribute("href")).toBe(topUpUrl);
});

test("used up: the warning shows with the same button", () => {
  const screen = render(
    <PhoneBalanceNotice
      balance={{
        balanceMils: 0,
        state: "empty",
        minutesLeftAtLeast: 0,
        topUpUrl,
        receivedAt: "2026-11-19T12:00:00.000Z",
      }}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("used up");
  expect(screen.getByRole("button", { name: "Add 5 hours" })).toBeTruthy();
});

test("a top-up address that is not https is never offered", () => {
  const screen = render(
    <PhoneBalanceNotice
      balance={{
        balanceMils: 0,
        state: "empty",
        minutesLeftAtLeast: 0,
        topUpUrl: "http://example.test/",
        receivedAt: "2026-11-19T12:00:00.000Z",
      }}
    />,
  );
  expect(screen.queryByRole("button", { name: "Add 5 hours" })).toBeNull();
});
