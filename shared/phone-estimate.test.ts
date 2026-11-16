import { describe, expect, test } from "bun:test";
import { EstimateError, estimatePhoneCost, euros } from "./phone-estimate";
import { PHONE_RATES } from "./phone-rates";

const greece = {
  iso: "GR",
  incomingHours: 10,
  outgoingHours: 0,
  employeeShare: 0.4,
  speechModel: "gpt-realtime-2.1",
};

describe("the phone add-on's cost estimate (#109)", () => {
  test("lists every EU and GCC country, with the add-on excluding VAT", () => {
    expect(PHONE_RATES.countries).toHaveLength(33);
    expect(PHONE_RATES.countries.filter((c) => c.region === "eu")).toHaveLength(
      27,
    );
    expect(
      PHONE_RATES.countries
        .filter((c) => c.region === "gcc")
        .map((c) => c.iso)
        .sort(),
    ).toEqual(["AE", "BH", "KW", "OM", "QA", "SA"]);
    expect(PHONE_RATES.blackArkMonthlyEur).toBe(20);
    expect(PHONE_RATES.eurUsd).toBe(1.1052);
  });

  test("Greece, 10 hours incoming: the number, the minutes and the speech, from the table", () => {
    const estimate = estimatePhoneCost(PHONE_RATES, greece);
    const line = (key: string) => estimate.lines.find((l) => l.key === key);
    // $1.00 a month at 1.1052.
    expect(line("number")?.low).toBeCloseTo(1 / 1.1052, 6);
    // 600 minutes x $0.0107.
    expect(line("incoming")?.low).toBeCloseTo((600 * 0.0107) / 1.1052, 6);
    expect(line("outgoing")).toMatchObject({ low: 0, high: 0, missing: false });
    // Speech: $0.0192 in, $0.0768 out per minute; 40% spoken by the employee.
    expect(line("speech")?.low).toBeCloseTo(
      (600 * (0.6 * 0.0192 + 0.4 * 0.0768)) / 1.1052,
      6,
    );
    expect(line("speech")?.high).toBeCloseTo(
      (600 * (0.0192 + 0.4 * 0.0768)) / 1.1052,
      6,
    );
    // Media Streams has no published rate in the table: missing, so the total is a floor.
    expect(line("streams")?.missing).toBe(true);
    expect(estimate.complete).toBe(false);
    expect(estimate.totalLow).toBeCloseTo(estimate.providersLow + 20, 6);
  });

  test("a price that is not published stays missing, never zero", () => {
    // Italy: no Local number price and no inbound rate in the table.
    const italy = estimatePhoneCost(PHONE_RATES, { ...greece, iso: "IT" });
    expect(italy.lines.find((l) => l.key === "number")?.missing).toBe(true);
    expect(italy.lines.find((l) => l.key === "incoming")?.missing).toBe(true);
    expect(italy.complete).toBe(false);
  });

  test("outgoing uses Twilio's From EEA rate in the EU, the default rate in the GCC, landline to mobile", () => {
    const gr = estimatePhoneCost(PHONE_RATES, {
      ...greece,
      incomingHours: 0,
      outgoingHours: 1,
    });
    const out = gr.lines.find((l) => l.key === "outgoing");
    expect(out?.low).toBeCloseTo((60 * 0.0214) / 1.1052, 6);
    expect(out?.high).toBeCloseTo((60 * 0.0746) / 1.1052, 6);
    const sa = estimatePhoneCost(PHONE_RATES, {
      ...greece,
      iso: "SA",
      incomingHours: 0,
      outgoingHours: 1,
    });
    const saOut = sa.lines.find((l) => l.key === "outgoing");
    expect(saOut?.low).toBeCloseTo((60 * 0.1738) / 1.1052, 6);
    expect(saOut?.high).toBeCloseTo((60 * 0.3122) / 1.1052, 6);
  });

  test("refuses an unknown country or model and out-of-range answers", () => {
    expect(() =>
      estimatePhoneCost(PHONE_RATES, { ...greece, iso: "US" }),
    ).toThrow(EstimateError);
    expect(() =>
      estimatePhoneCost(PHONE_RATES, { ...greece, speechModel: "gpt-live-1" }),
    ).toThrow(EstimateError);
    expect(() =>
      estimatePhoneCost(PHONE_RATES, { ...greece, incomingHours: -1 }),
    ).toThrow(EstimateError);
    expect(() =>
      estimatePhoneCost(PHONE_RATES, { ...greece, employeeShare: 1 }),
    ).toThrow(EstimateError);
    expect(euros(20)).toBe("€20.00");
  });
});
