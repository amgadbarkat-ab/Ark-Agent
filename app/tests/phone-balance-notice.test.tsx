import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  BLACKARK_RELAY_URL,
  PhoneBalanceNotice,
} from "@/components/settings/phone-line-section";

/**
 * The phone balance in Settings, then Phone line (#109, v0.1.49 end to end): in the last hour the
 * app says so and offers "Add 5 hours" on BlackArk's top-up page; used up, it says calls are not
 * answered; otherwise the balance. From v0.1.50 (#149, 19 Nov) "Add 5 hours" is offered at any
 * balance, and a new line points at BlackArk's relay on Cloudflare Workers. The balance is what
 * server/tests/phone-addon-e2e reads.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const topUpUrl = "https://blackark.uk/checkin/buy/?topup=1&customer=demo-phone";
const balance = (state: "ok" | "low" | "empty", balanceMils: number) => ({
  balanceMils,
  state,
  minutesLeftAtLeast: Math.floor(balanceMils / 139),
  topUpUrl,
  receivedAt: "2026-11-19T05:00:00.000Z",
});

test("in the last hour: the notice, and Add 5 hours on the top-up page", () => {
  const screen = render(<PhoneBalanceNotice balance={balance("low", 5304)} />);
  expect(screen.getByRole("alert").textContent).toContain(
    "Less than one hour of phone balance is left",
  );
  const add = screen.getByRole("button", { name: "Add 5 hours" });
  expect(add.getAttribute("href")).toBe(topUpUrl);
});

test("used up: calls are not answered, and Add 5 hours", () => {
  const screen = render(<PhoneBalanceNotice balance={balance("empty", 0)} />);
  expect(screen.getByRole("alert").textContent).toContain(
    "calls are not answered",
  );
  expect(screen.getByRole("button", { name: "Add 5 hours" })).toBeTruthy();
});

test("topped up: the balance with no alert, and 5 more hours can still be bought", () => {
  const screen = render(<PhoneBalanceNotice balance={balance("ok", 23_400)} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(/at least 168 minutes/)).toBeTruthy();
  const add = screen.getByRole("button", { name: "Add 5 hours" });
  expect(add.getAttribute("href")).toBe(topUpUrl);
});

test("a top-up address that is not https is never offered", () => {
  const screen = render(
    <PhoneBalanceNotice
      balance={{ ...balance("empty", 0), topUpUrl: "http://example.test/" }}
    />,
  );
  expect(screen.queryByRole("button", { name: "Add 5 hours" })).toBeNull();
});

test("a new line connects to BlackArk's relay on Cloudflare Workers", () => {
  expect(BLACKARK_RELAY_URL).toBe(
    "https://blackark-phone.blackark.workers.dev",
  );
});
