import { describe, expect, test } from "bun:test";
import {
  BILLING_MONTH_SECONDS,
  type CloudRates,
  checkRates,
  chargeCents,
  costOf,
  isBelowMinimum,
  NO_USAGE,
} from "./cloud-pricing";

const RATES: CloudRates = {
  computeCentsPerHour: 10,
  storageCentsPerGbMonth: 20,
  egressCentsPerGb: 8,
  paymentFeePercent: 5,
  paymentFeeFixedCents: 50,
  marginPercent: 0,
  minimumChargeCents: 500,
};
const GIB = 1024 ** 3;

describe("cost", () => {
  test("is hours, gigabyte-months and gigabytes, each at its own price", () => {
    const usage = {
      computeSeconds: 3 * 3600,
      storageByteSeconds: 2 * GIB * BILLING_MONTH_SECONDS,
      egressBytes: 5 * GIB,
    };
    const cost = costOf(usage, RATES);
    expect(cost.computeHours).toBe(3);
    expect(cost.storageGbMonths).toBeCloseTo(2, 10);
    expect(cost.egressGb).toBe(5);
    expect(cost.computeCents).toBe(30);
    expect(cost.storageCents).toBeCloseTo(40, 8);
    expect(cost.egressCents).toBe(40);
    expect(cost.costCents).toBeCloseTo(110, 8);
  });

  test("nothing used costs nothing", () => {
    expect(costOf(NO_USAGE, RATES).costCents).toBe(0);
  });
});

describe("the charge", () => {
  test("after the payment provider's fee, what is left covers the cost, to the cent", () => {
    // Cost 1000 cents. Fee 5% + 50.
    const usage = { ...NO_USAGE, computeSeconds: 100 * 3600 };
    const charge = chargeCents(usage, RATES);
    const kept = charge - (charge * 5) / 100 - 50;
    expect(kept).toBeGreaterThanOrEqual(1000);
    // And not a whole cent more than needed.
    const one_less = charge - 1;
    expect(one_less - (one_less * 5) / 100 - 50).toBeLessThan(1000);
  });

  test("adding the fee to the cost, which is the tempting wrong answer, falls short", () => {
    const usage = { ...NO_USAGE, computeSeconds: 100 * 3600 };
    const naive = 1000 + 1000 * 0.05 + 50;
    const kept = naive - naive * 0.05 - 50;
    expect(kept).toBeLessThan(1000);
    expect(chargeCents(usage, RATES)).toBeGreaterThan(naive);
  });

  test("is always rounded up, so the promise to cover cost is never broken by rounding", () => {
    for (const seconds of [1, 7, 61, 3599, 3601, 123456]) {
      const usage = { ...NO_USAGE, computeSeconds: seconds };
      const charge = chargeCents(usage, RATES);
      expect(Number.isInteger(charge)).toBe(true);
      const cost = costOf(usage, RATES).costCents;
      expect(charge * 0.95 - 50).toBeGreaterThanOrEqual(cost - 1e-6);
    }
  });

  test("an empty month is not charged the fixed fee", () => {
    expect(chargeCents(NO_USAGE, RATES)).toBe(0);
  });

  test("a margin is added to cost before the fee, and zero is zero", () => {
    const usage = { ...NO_USAGE, computeSeconds: 100 * 3600 };
    const plain = chargeCents(usage, RATES);
    const withMargin = chargeCents(usage, { ...RATES, marginPercent: 20 });
    expect(withMargin).toBeGreaterThan(plain);
    // Cost 1000 + 20% = 1200, plus the fee grossed up.
    expect(withMargin).toBe(Math.ceil((1200 + 50) / 0.95));
  });

  test("earlier months that fell under the minimum are carried in and pay one fee, not two", () => {
    const small = { ...NO_USAGE, computeSeconds: 3600 };
    const cost = costOf(small, RATES).costCents; // 10
    const separate = chargeCents(small, RATES) * 2;
    const together = chargeCents(small, RATES, cost);
    expect(together).toBeLessThan(separate);
    expect(together).toBe(Math.ceil((20 + 50) / 0.95));
  });

  test("a charge under the minimum is reported as one, an empty one is not", () => {
    expect(isBelowMinimum(120, RATES)).toBe(true);
    expect(isBelowMinimum(500, RATES)).toBe(false);
    expect(isBelowMinimum(0, RATES)).toBe(false);
  });
});

describe("checking rates a person typed", () => {
  test("a good set passes, unchanged", () => {
    expect(checkRates(RATES)).toEqual({ ok: true, rates: RATES });
  });

  test("a negative, missing, non-numeric or absurd one is refused in words", () => {
    for (const change of [
      { computeCentsPerHour: -1 },
      { computeCentsPerHour: 0 },
      { computeCentsPerHour: "10" },
      { computeCentsPerHour: Number.NaN },
      { computeCentsPerHour: Number.POSITIVE_INFINITY },
      { computeCentsPerHour: 1_000_000 },
      { paymentFeePercent: 100 },
      { storageCentsPerGbMonth: undefined },
    ]) {
      const checked = checkRates({ ...RATES, ...change });
      expect(checked.ok).toBe(false);
    }
  });

  test("anything that is not a set of known rates is refused", () => {
    for (const input of [null, [], "x", 5, { ...RATES, surprise: 1 }]) {
      expect(checkRates(input).ok).toBe(false);
    }
  });
});
