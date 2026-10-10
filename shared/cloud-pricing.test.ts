import { describe, expect, test } from "bun:test";
import {
  BILLING_MONTH_SECONDS,
  type CloudRates,
  checkRates,
  chargeCents,
  chargeForParts,
  costOf,
  isBelowMinimum,
  NO_USAGE,
  sameRates,
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

describe("a month that straddles a change of prices", () => {
  const hours = (n: number) => ({
    computeSeconds: n * 3600,
    storageByteSeconds: 0,
    egressBytes: 0,
  });
  const DEARER: CloudRates = { ...RATES, computeCentsPerHour: 20 };

  test("one part is exactly the single-agreement charge", () => {
    expect(chargeForParts([{ usage: hours(7), rates: RATES }])).toBe(
      chargeCents(hours(7), RATES),
    );
    expect(chargeForParts([{ usage: hours(7), rates: RATES }], 130)).toBe(
      chargeCents(hours(7), RATES, 130),
    );
  });

  test("each part is priced at the rates agreed for it, and the fee is paid once", () => {
    // 3 hours at 10 = 30, 2 hours at 20 = 40: cost 70, then one fee of 5% + 50.
    expect(
      chargeForParts([
        { usage: hours(3), rates: RATES },
        { usage: hours(2), rates: DEARER },
      ]),
    ).toBe(Math.ceil((70 + 50) / 0.95));
  });

  test("is neither the old prices for everything nor the new prices for everything", () => {
    const mixed = chargeForParts([
      { usage: hours(3), rates: RATES },
      { usage: hours(2), rates: DEARER },
    ]);
    expect(mixed).toBeGreaterThan(chargeCents(hours(5), RATES));
    expect(mixed).toBeLessThan(chargeCents(hours(5), DEARER));
  });

  test("each part carries the margin it was agreed with", () => {
    const margin: CloudRates = { ...RATES, marginPercent: 50 };
    // 30 plain, 2 hours at 10 plus half again = 30, fee on 60.
    expect(
      chargeForParts([
        { usage: hours(3), rates: RATES },
        { usage: hours(2), rates: margin },
      ]),
    ).toBe(Math.ceil((30 + 20 * 1.5 + 50) / 0.95));
  });

  test("the newest agreement's fee and margin close the month, including on what was carried", () => {
    const newer: CloudRates = {
      ...RATES,
      paymentFeePercent: 10,
      paymentFeeFixedCents: 30,
      marginPercent: 20,
    };
    expect(
      chargeForParts([{ usage: hours(3), rates: RATES }], 100, newer),
    ).toBe(Math.ceil((30 + 100 * 1.2 + 30) / 0.9));
  });

  test("nothing used and nothing carried is nothing, not the fixed fee", () => {
    expect(chargeForParts([], 0, RATES)).toBe(0);
    expect(chargeForParts([{ usage: NO_USAGE, rates: RATES }])).toBe(0);
    expect(chargeForParts([])).toBe(0);
  });

  test("prices are the same prices only if every one is", () => {
    expect(sameRates(RATES, { ...RATES })).toBe(true);
    for (const key of Object.keys(RATES) as (keyof CloudRates)[]) {
      expect(sameRates(RATES, { ...RATES, [key]: RATES[key] + 1 })).toBe(false);
    }
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
