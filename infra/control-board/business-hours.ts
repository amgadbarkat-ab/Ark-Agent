/**
 * BlackArk's support hours and the SLA built on them (Amgad, 18 Nov 2026, #149):
 * - support is open Monday to Friday, 09:00 to 18:00, Athens time;
 * - trial customers: an answer by the end of the next business day;
 * - paid customers, urgent: within 4 business hours;
 * - paid customers, normal: by the end of the next business day.
 *
 * "The next business day" is the first business day after the day the case arrives, so a case that
 * arrives on Monday (at any hour) is due by Tuesday 18:00, and one that arrives on Friday evening is
 * due by Monday 18:00. Public holidays are days off when listed (`BOARD_HOLIDAYS`); none are built
 * in yet (an open question for Amgad).
 *
 * No time-zone package: Athens' offset at a moment comes from Intl, which knows its summer time.
 */

export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 18;
export const URGENT_PAID_HOURS = 4;

export type Plan = "trial" | "paid";
export type Urgency = "urgent" | "normal";

const PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Athens",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

function wall(ms: number): Wall {
  const out: Record<string, string> = {};
  for (const part of PARTS.formatToParts(ms)) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday ?? "",
  };
}

/** The moment Athens' clocks show this date and time. */
function athens(
  year: number,
  month: number,
  day: number,
  hour: number,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const shown = wall(guess);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    guess += asUtc - shownAsUtc;
  }
  return guess;
}

function dateKey(w: Wall): string {
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

export type Calendar = { holidays?: ReadonlySet<string> };

function isBusinessDay(w: Wall, calendar: Calendar): boolean {
  return (
    w.weekday !== "Sat" &&
    w.weekday !== "Sun" &&
    !calendar.holidays?.has(dateKey(w))
  );
}

/** Noon on the next calendar day in Athens (noon, so a summer-time change never skips the day). */
function nextDay(w: Wall): Wall {
  return wall(athens(w.year, w.month, w.day, 12) + 24 * 3_600_000);
}

/** 09:00 on the first business day after the day of `ms`. */
function nextOpening(ms: number, calendar: Calendar): number {
  let day = nextDay(wall(ms));
  while (!isBusinessDay(day, calendar)) day = nextDay(day);
  return athens(day.year, day.month, day.day, OPEN_HOUR);
}

/** 18:00 on the first business day after the day the case arrived. */
export function endOfNextBusinessDay(
  ms: number,
  calendar: Calendar = {},
): number {
  const opening = wall(nextOpening(ms, calendar));
  return athens(opening.year, opening.month, opening.day, CLOSE_HOUR);
}

/** `hours` of open time after `ms`, counting only business days 09:00 to 18:00 in Athens. */
export function addBusinessHours(
  ms: number,
  hours: number,
  calendar: Calendar = {},
): number {
  let left = hours * 3_600_000;
  let at = ms;
  for (let guard = 0; guard < 400; guard++) {
    const w = wall(at);
    const open = athens(w.year, w.month, w.day, OPEN_HOUR);
    const close = athens(w.year, w.month, w.day, CLOSE_HOUR);
    if (!isBusinessDay(w, calendar) || at >= close) {
      at = nextOpening(at, calendar);
      continue;
    }
    if (at < open) at = open;
    if (at + left <= close) return at + left;
    left -= close - at;
    at = nextOpening(at, calendar);
  }
  throw new Error("No business hours found.");
}

/** When a first answer is due, by the customer's plan and the case's urgency. */
export function slaDue(
  createdMs: number,
  plan: Plan,
  urgency: Urgency,
  calendar: Calendar = {},
): number {
  return plan === "paid" && urgency === "urgent"
    ? addBusinessHours(createdMs, URGENT_PAID_HOURS, calendar)
    : endOfNextBusinessDay(createdMs, calendar);
}

/** `BOARD_HOLIDAYS=2026-12-25,2027-01-01`: days off besides weekends. */
export function holidaysFrom(text: string | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .split(",")
      .map((day) => day.trim())
      .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)),
  );
}
