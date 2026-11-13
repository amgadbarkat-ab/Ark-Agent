const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

import { type Language, storedLanguage } from "./i18n";

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});
const greekFormat = new Intl.RelativeTimeFormat("el", { numeric: "auto" });

/**
 * Locale-aware relative timestamp, e.g. "2 minutes ago".
 *
 * In Greek when the app is set to Greek, whatever the browser's own locale (DT Lab, #83: the Greek
 * Requests list said «Ζητήθηκε yesterday»). Otherwise the browser's locale, as it always was.
 */
export function relativeTime(
  iso: string,
  language: Language = storedLanguage(),
): string {
  const format = language === "el" ? greekFormat : relativeFormat;
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  const elapsed = Date.now() - time;
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return format.format(-Math.round(elapsed / scale.divisor), scale.unit);
}
