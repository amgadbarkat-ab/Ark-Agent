import { describe, expect, test } from "bun:test";
import {
  clip,
  merge,
  periodBounds,
  periodOf,
  previousPeriod,
  seconds,
} from "../src/cloud/intervals";

describe("billing periods", () => {
  test("a period is a UTC calendar month, and the next begins where it ends", () => {
    const october = periodBounds("2026-10");
    expect(october.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(october.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(periodBounds("2026-12").end.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  test("an instant belongs to the month it is in, in UTC, even when the local date says otherwise", () => {
    expect(periodOf(new Date("2026-10-31T23:59:59.999Z"))).toBe("2026-10");
    expect(periodOf(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
  });

  test("the month before, across a year", () => {
    expect(previousPeriod("2026-10")).toBe("2026-09");
    expect(previousPeriod("2027-01")).toBe("2026-12");
  });

  test("anything that is not a period is refused", () => {
    for (const bad of [
      "2026-13",
      "2026-00",
      "26-10",
      "2026-1",
      "",
      "2026-10-01",
    ]) {
      expect(() => periodBounds(bad)).toThrow(/Not a billing period/);
    }
  });
});

describe("spans", () => {
  const hour = 3_600_000;

  test("clipped to a window, and nothing if they never meet", () => {
    expect(clip({ start: 0, end: 10 }, { start: 5, end: 20 })).toEqual({
      start: 5,
      end: 10,
    });
    expect(clip({ start: 0, end: 5 }, { start: 5, end: 20 })).toBeNull();
    expect(clip({ start: 30, end: 40 }, { start: 5, end: 20 })).toBeNull();
  });

  test("overlapping and touching spans are one, so an hour is counted once", () => {
    const merged = merge([
      { start: 0, end: hour },
      { start: hour / 2, end: hour * 2 },
      { start: hour * 2, end: hour * 3 },
      { start: hour * 5, end: hour * 6 },
    ]);
    expect(merged).toEqual([
      { start: 0, end: hour * 3 },
      { start: hour * 5, end: hour * 6 },
    ]);
    expect(seconds(merged)).toBe(4 * 3600);
  });

  test("a span inside another adds nothing", () => {
    expect(
      seconds(
        merge([
          { start: 0, end: hour },
          { start: 10, end: 20 },
        ]),
      ),
    ).toBe(3600);
  });

  test("none at all is none", () => {
    expect(merge([])).toEqual([]);
    expect(seconds([])).toBe(0);
  });
});
