/**
 * What the phone add-on would cost a business a month (#109, MD 15–16 Nov), from the rate table.
 *
 * A line is a range (low to high) in EUR. A price the source did not publish makes its line
 * `missing`, and the total then reads "at least": nothing is ever counted as zero. Provider costs are
 * list prices converted at the ECB rate in the table; BlackArk's add-on is shown apart, excluding VAT.
 */
import type { CountryRates, PhoneRates } from "./phone-rates";

export type EstimateInput = {
  iso: string;
  incomingHours: number;
  outgoingHours: number;
  /** How much of a call the employee speaks, 0.1 to 0.9. */
  employeeShare: number;
  speechModel: string;
};

export type EstimateLine = {
  key: "number" | "incoming" | "outgoing" | "streams" | "speech";
  low: number;
  high: number;
  missing: boolean;
};

export type Estimate = {
  country: CountryRates;
  lines: EstimateLine[];
  /** Twilio and OpenAI together, EUR a month, at list prices. */
  providersLow: number;
  providersHigh: number;
  /** BlackArk's add-on, EUR a month, excluding VAT. */
  blackArk: number;
  totalLow: number;
  totalHigh: number;
  /** False when a needed price is not published: the totals are then a floor. */
  complete: boolean;
};

export class EstimateError extends Error {}

function bounded(
  value: number,
  what: string,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new EstimateError(`${what} must be from ${min} to ${max}.`);
  }
  return value;
}

export function estimatePhoneCost(
  rates: PhoneRates,
  input: EstimateInput,
): Estimate {
  const country = rates.countries.find((c) => c.iso === input.iso);
  if (!country) throw new EstimateError("Choose a country from the list.");
  const speech = rates.speechModels.find((m) => m.id === input.speechModel);
  if (!speech) throw new EstimateError("Choose a speech model from the list.");
  const inMinutes =
    bounded(input.incomingHours, "Incoming hours", 0, 2000) * 60;
  const outMinutes =
    bounded(input.outgoingHours, "Outgoing hours", 0, 2000) * 60;
  const share = bounded(input.employeeShare, "The employee's share", 0.1, 0.9);
  const eur = (usd: number) => usd / rates.eurUsd;

  const lines: EstimateLine[] = [];
  const fixed = (key: EstimateLine["key"], usd: number | null, needed = true) =>
    lines.push(
      usd === null
        ? { key, low: 0, high: 0, missing: needed }
        : { key, low: eur(usd), high: eur(usd), missing: false },
    );

  fixed("number", country.localNumberMonthly);
  fixed(
    "incoming",
    country.inboundLocal === null ? null : country.inboundLocal * inMinutes,
    inMinutes > 0,
  );

  // A call out from the business's own (EEA) number: Twilio's From EEA rate where it publishes one.
  const pick = (fromEea: number | null, fallback: number | null) =>
    country.region === "eu" && fromEea !== null ? fromEea : fallback;
  const outRates = [
    pick(country.landlineFromEea, country.landlineDefault),
    pick(country.mobileFromEea, country.mobileDefault),
  ].filter((rate): rate is number => rate !== null);
  if (outMinutes === 0) {
    lines.push({ key: "outgoing", low: 0, high: 0, missing: false });
  } else if (outRates.length === 0) {
    lines.push({ key: "outgoing", low: 0, high: 0, missing: true });
  } else {
    lines.push({
      key: "outgoing",
      low: eur(Math.min(...outRates) * outMinutes),
      high: eur(Math.max(...outRates) * outMinutes),
      missing: false,
    });
  }

  const minutes = inMinutes + outMinutes;
  fixed(
    "streams",
    rates.mediaStreamsPerMinute === null
      ? null
      : rates.mediaStreamsPerMinute * minutes,
    minutes > 0,
  );

  // Speech: caller audio in, the employee's audio out. Low counts the caller's audio only while
  // they speak; high counts it for the whole call (it is streamed throughout).
  const inPerMinute =
    (rates.audioTokensPerMinuteIn * speech.audioIn) / 1_000_000;
  const outPerMinute =
    (rates.audioTokensPerMinuteOut * speech.audioOut) / 1_000_000;
  lines.push({
    key: "speech",
    low: eur(minutes * ((1 - share) * inPerMinute + share * outPerMinute)),
    high: eur(minutes * (inPerMinute + share * outPerMinute)),
    missing: false,
  });

  const providersLow = lines.reduce((sum, line) => sum + line.low, 0);
  const providersHigh = lines.reduce((sum, line) => sum + line.high, 0);
  const complete = !lines.some((line) => line.missing);
  return {
    country,
    lines,
    providersLow,
    providersHigh,
    blackArk: rates.blackArkMonthlyEur,
    totalLow: providersLow + rates.blackArkMonthlyEur,
    totalHigh: providersHigh + rates.blackArkMonthlyEur,
    complete,
  };
}

/** Euros as the estimator shows them: two decimals. */
export function euros(value: number): string {
  return `€${value.toFixed(2)}`;
}
