/**
 * Arithmetic on stretches of time, and nothing else: clipping to a month and merging overlaps.
 *
 * Kept apart from the database so the part that decides what somebody is charged for can be tested
 * with a handful of numbers and no clock.
 */

export type Span = { start: number; end: number };

/** The first instant of a month and of the next, in UTC, for a period named `2026-10`. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error(`Not a billing period: ${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

/** The billing period an instant is in: its UTC month. */
export function periodOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month before a period. */
export function previousPeriod(period: string): string {
  const { start } = periodBounds(period);
  return periodOf(new Date(start.getTime() - 1));
}

/** The part of a span inside a window, or nothing. */
export function clip(span: Span, window: Span): Span | null {
  const start = Math.max(span.start, window.start);
  const end = Math.min(span.end, window.end);
  return end > start ? { start, end } : null;
}

/** Overlapping and touching spans joined into one, so that time is counted once. */
export function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

export const seconds = (spans: readonly Span[]): number =>
  spans.reduce((total, span) => total + (span.end - span.start) / 1000, 0);
