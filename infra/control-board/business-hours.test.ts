import { describe, expect, test } from "bun:test";
import {
  addBusinessHours,
  endOfNextBusinessDay,
  holidaysFrom,
  slaDue,
} from "./business-hours";

// Athens is UTC+2 in winter and UTC+3 in summer (until 25 Oct 2026, from 28 Mar 2027).
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("Athens business hours, Mon-Fri 09:00-18:00", () => {
  test("paid urgent: 4 business hours within one day", () => {
    // Wed 18 Nov 2026 10:00 Athens -> 14:00 Athens.
    expect(iso(slaDue(at("2026-11-18T08:00:00Z"), "paid", "urgent"))).toBe(
      "2026-11-18T12:00:00.000Z",
    );
  });

  test("paid urgent late in the day carries over to the next morning", () => {
    // Wed 16:30 Athens: 1.5 h today, 2.5 h from Thu 09:00 -> Thu 11:30 Athens.
    expect(iso(slaDue(at("2026-11-18T14:30:00Z"), "paid", "urgent"))).toBe(
      "2026-11-19T09:30:00.000Z",
    );
  });

  test("paid urgent on Friday afternoon carries over the weekend", () => {
    // Fri 20 Nov 17:00 Athens: 1 h Friday, 3 h Monday -> Mon 23 Nov 12:00 Athens.
    expect(iso(slaDue(at("2026-11-20T15:00:00Z"), "paid", "urgent"))).toBe(
      "2026-11-23T10:00:00.000Z",
    );
  });

  test("paid urgent at night or at the weekend starts at the next opening", () => {
    // Sat 21 Nov 11:00 Athens -> Mon 09:00 + 4 h = Mon 13:00 Athens.
    expect(iso(slaDue(at("2026-11-21T09:00:00Z"), "paid", "urgent"))).toBe(
      "2026-11-23T11:00:00.000Z",
    );
    // Thu 07:00 Athens -> Thu 09:00 + 4 h = 13:00 Athens.
    expect(iso(addBusinessHours(at("2026-11-19T05:00:00Z"), 4))).toBe(
      "2026-11-19T11:00:00.000Z",
    );
  });

  test("trial, and paid normal: the end of the next business day", () => {
    // Wed 10:00 Athens -> Thu 18:00 Athens.
    expect(iso(slaDue(at("2026-11-18T08:00:00Z"), "trial", "normal"))).toBe(
      "2026-11-19T16:00:00.000Z",
    );
    expect(iso(slaDue(at("2026-11-18T08:00:00Z"), "paid", "normal"))).toBe(
      "2026-11-19T16:00:00.000Z",
    );
    // A trial marked urgent is still the next business day.
    expect(iso(slaDue(at("2026-11-18T08:00:00Z"), "trial", "urgent"))).toBe(
      "2026-11-19T16:00:00.000Z",
    );
    // Fri 20:00 Athens and Sun -> Mon 18:00 Athens.
    expect(iso(endOfNextBusinessDay(at("2026-11-20T18:00:00Z")))).toBe(
      "2026-11-23T16:00:00.000Z",
    );
    expect(iso(endOfNextBusinessDay(at("2026-11-22T10:00:00Z")))).toBe(
      "2026-11-23T16:00:00.000Z",
    );
  });

  test("summer time: the same wall-clock hours, one hour earlier in UTC", () => {
    // Tue 6 Oct 2026 10:00 Athens (UTC+3) -> Wed 18:00 Athens = 15:00 UTC.
    expect(iso(endOfNextBusinessDay(at("2026-10-06T07:00:00Z")))).toBe(
      "2026-10-07T15:00:00.000Z",
    );
    // Across the change: Fri 23 Oct 17:00 Athens (UTC+3), 1 h Fri, 3 h Mon 26 Oct (UTC+2) -> 12:00 = 10:00 UTC.
    expect(iso(addBusinessHours(at("2026-10-23T14:00:00Z"), 4))).toBe(
      "2026-10-26T10:00:00.000Z",
    );
  });

  test("a listed holiday is a day off", () => {
    const calendar = { holidays: holidaysFrom("2026-11-19, nonsense") };
    expect(calendar.holidays.size).toBe(1);
    // Wed 10:00 -> Thu is a holiday -> Fri 18:00 Athens.
    expect(
      iso(endOfNextBusinessDay(at("2026-11-18T08:00:00Z"), calendar)),
    ).toBe("2026-11-20T16:00:00.000Z");
    // Wed 16:30 urgent: 1.5 h Wed, 2.5 h Fri -> Fri 11:30 Athens.
    expect(
      iso(slaDue(at("2026-11-18T14:30:00Z"), "paid", "urgent", calendar)),
    ).toBe("2026-11-20T09:30:00.000Z");
  });
});
