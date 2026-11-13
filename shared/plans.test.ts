import { expect, test } from "bun:test";
import {
  formatEur,
  nextPlanUp,
  PLANS,
  planById,
  purchasablePlans,
  subscriptionAllowsRuns,
  trialDaysLeft,
  trialEndFrom,
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

test("trial days are counted up, and day 8 is zero", () => {
  const start = new Date("2026-11-14T09:00:00Z");
  const end = trialEndFrom(start);
  expect(end.toISOString()).toBe("2026-11-21T09:00:00.000Z");
  expect(trialDaysLeft(end, start)).toBe(7);
  expect(trialDaysLeft(end, new Date("2026-11-20T09:00:01Z"))).toBe(1);
  expect(trialDaysLeft(end, end)).toBe(0);
});
