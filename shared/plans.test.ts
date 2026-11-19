import { describe, expect, test } from "bun:test";
import {
  AGENT_TIERS,
  agentLimitFor,
  agentLimitNotice,
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

describe("Ark Team tiers (v0.1.49, COO's Stripe setup of 19 Nov)", () => {
  test("three tiers, per seat a month: 5 for €100, 10 for €140, 20 for €200", () => {
    expect(
      AGENT_TIERS.map((tier) => [tier.agentsPerSeat, tier.priceEurCents / 100]),
    ).toEqual([
      [5, 100],
      [10, 140],
      [20, 200],
    ]);
    // The plan's own price is the tier it starts from, so the plan picker still says "from €100".
    expect(planById("team")?.priceEurCents).toBe(10_000);
  });

  test("the limit is agents per seat times seats, for the whole install", () => {
    expect(agentLimitFor({ planId: "team", agentsPerSeat: 5, seats: 1 })).toBe(
      5,
    );
    expect(agentLimitFor({ planId: "team", agentsPerSeat: 10, seats: 1 })).toBe(
      10,
    );
    expect(agentLimitFor({ planId: "team", agentsPerSeat: 20, seats: 1 })).toBe(
      20,
    );
    expect(agentLimitFor({ planId: "team", agentsPerSeat: 10, seats: 3 })).toBe(
      30,
    );
  });

  test("a team key without a tier counts as 5 per seat", () => {
    expect(agentLimitFor({ planId: "team", seats: 2 })).toBe(10);
    expect(agentLimitFor({ planId: "team" })).toBe(5);
  });

  test("ArkAgent, Enterprise and Internal have no agent limit, as before", () => {
    expect(agentLimitFor({ planId: "agent", seats: 1 })).toBeNull();
    expect(
      agentLimitFor({ planId: "enterprise", agentsPerSeat: 5, seats: 1 }),
    ).toBeNull();
    expect(agentLimitFor({ planId: "internal" })).toBeNull();
  });

  test("the concurrency limits are unchanged", () => {
    expect(planById("agent")?.maxActiveBots).toBe(1);
    expect(planById("team")?.maxActiveBots).toBe(15);
    expect(planById("enterprise")?.maxActiveBots).toBe(500);
  });

  test("the notice names the next tier and its price, in English and Greek", () => {
    const five = agentLimitNotice({
      limit: 5,
      inUse: 5,
      agentsPerSeat: 5,
      trial: false,
    });
    expect(five.en).toBe(
      "Your Ark Team plan allows 5 digital employees on this computer, and 5 are set up. To add more, move up to 10 digital employees per person (€140 per person a month) in the billing portal, or add a person to your subscription.",
    );
    expect(five.el).toBe(
      "Το πρόγραμμα Ark Team επιτρέπει 5 ψηφιακούς υπαλλήλους σε αυτόν τον υπολογιστή και υπάρχουν ήδη 5. Για περισσότερους, περάστε στους 10 ψηφιακούς υπαλλήλους ανά άτομο (€140 ανά άτομο τον μήνα) από την πύλη χρεώσεων ή προσθέστε ένα άτομο στη συνδρομή σας.",
    );
    expect(
      agentLimitNotice({
        limit: 20,
        inUse: 23,
        agentsPerSeat: 20,
        trial: false,
      }).en,
    ).toBe(
      "Your Ark Team plan allows 20 digital employees on this computer, and 23 are set up. To add more, add a person to your subscription in the billing portal: each person adds 20.",
    );
    expect(
      agentLimitNotice({ limit: 5, inUse: 5, agentsPerSeat: 5, trial: true })
        .en,
    ).toBe(
      "Your trial allows 5 digital employees on this computer, and 5 are set up. To have more, choose Ark Team with 10 or 20 digital employees per person when you buy.",
    );
  });
});
