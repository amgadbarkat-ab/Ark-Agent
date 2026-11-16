import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneEstimator } from "@/components/settings/phone-estimator";

/**
 * The phone add-on's cost estimate on screen (#109, MD 16 Nov): every EU and GCC country, a
 * line per cost, missing prices shown as missing with an "at least" total, and €20 excluding VAT.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("lists the 33 countries and prices Greece line by line, with the add-on excluding VAT", async () => {
  const screen = render(<PhoneEstimator />);
  const country = screen.getByLabelText("Country") as HTMLSelectElement;
  expect(country.options).toHaveLength(33);
  expect(country.value).toBe("GR");
  expect(screen.getByText("BlackArk add-on, excluding VAT")).toBeTruthy();
  expect(screen.getByText("€20.00")).toBeTruthy();
  // Media Streams has no published rate in the table, so the total is a floor.
  expect(
    screen.getByText("not published: ask BlackArk for a quote"),
  ).toBeTruthy();
  expect(screen.getByText(/^at least €/)).toBeTruthy();
});

test("a country with no published number price says so, and the summary can be made to send", async () => {
  const user = userEvent.setup({ document });
  const screen = render(<PhoneEstimator />);
  await user.selectOptions(screen.getByLabelText("Country"), "IT");
  expect(
    screen.getAllByText("not published: ask BlackArk for a quote").length,
  ).toBeGreaterThan(1);
  await user.click(screen.getByRole("button", { name: "Request activation" }));
  const summary = (
    screen.container.querySelector("textarea") as HTMLTextAreaElement
  ).value;
  expect(summary).toContain("Country: Italy");
  expect(summary).toContain("€20.00 a month, excluding VAT");
  expect(summary).toContain("1 EUR = 1.1052 USD");
  expect(screen.getByText(/Nothing has been sent or paid/)).toBeTruthy();
});
