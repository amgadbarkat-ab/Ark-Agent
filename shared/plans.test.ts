import { expect, test } from "bun:test";
import {
  formatEur,
  nextPlanUp,
  PLANS,
  planById,
  purchasablePlans,
  subscriptionAllowsRuns,
} from "./plans";

test("the three plans are what was agreed", () => {
  expect(
    purchasablePlans().map((p) => [
      p.id,
      p.priceEurCents / 100,
      p.maxActiveBots,
    ]),
  ).toEqual([
    ["agent", 50, 1],
    ["team", 100, 15],
    ["enterprise", 250, 500],
  ]);
});

test("every plan is for one user until shared seats are decided", () => {
  expect(PLANS.every((plan) => plan.seats === 1)).toBe(true);
});

test("the internal plan is never offered and has no limit", () => {
  const internal = planById("internal");
  expect(internal?.purchasable).toBe(false);
  expect(internal?.maxActiveBots).toBeNull();
  expect(purchasablePlans().some((p) => p.id === "internal")).toBe(false);
});

test("the upgrade offered is the next plan that allows more", () => {
  expect(nextPlanUp("agent")?.id).toBe("team");
  expect(nextPlanUp("team")?.id).toBe("enterprise");
  expect(nextPlanUp("enterprise")).toBeUndefined();
  expect(nextPlanUp("internal")).toBeUndefined();
  expect(nextPlanUp("nonsense")).toBeUndefined();
});

test("prices read as people write them", () => {
  expect(formatEur(5000)).toBe("€50");
  expect(formatEur(4950)).toBe("€49.50");
});

test("a failed card does not stop work, a cancelled or unfinished subscription does", () => {
  expect(subscriptionAllowsRuns("active")).toBe(true);
  expect(subscriptionAllowsRuns("trialing")).toBe(true);
  expect(subscriptionAllowsRuns("past_due")).toBe(true);
  expect(subscriptionAllowsRuns("incomplete")).toBe(false);
  expect(subscriptionAllowsRuns("canceled")).toBe(false);
});
