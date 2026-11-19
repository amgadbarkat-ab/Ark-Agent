/**
 * What the pages show, worked out from the check-in export. Pure functions of the export and the
 * time, so the pages can be tested against a stand-in export with a fixed clock.
 */
import type {
  CheckinExport,
  Install,
  LedgerEntry,
  Licence,
  PhoneAccount,
} from "./sources";

export const SILENT_MS = 2 * 86_400_000;
export const ENDING_DAYS = 7;

export type Plan = "paid" | "trial" | "ended";

export type CustomerRow = {
  customerId: string;
  installs: Install[];
  /** The version of the install heard from last. */
  version: string | null;
  plan: Plan;
  /** The paid plan's name ("team"), when paid through a licence. */
  planName: string | null;
  addons: string[];
  daysLeft: number | null;
  endsAt: string | null;
  phone: PhoneAccount | null;
  lastSeen: string | null;
  silentInstalls: number;
  /** More than one install heard from in the last 7 days (the status page's flag). */
  severalInstalls: boolean;
  /**
   * Ark Team's tier from the active licence (v0.1.49): digital employees per seat, and whether the
   * key named it (an older key does not, and counts as 5). Null without an active team licence.
   */
  agentsPerSeat: number | null;
  tierNamed: boolean;
  seats: number | null;
  /** Agents per seat times seats. Null without an active team licence. */
  maxAgents: number | null;
  /**
   * How many digital employees the install has. The check-in's counts do not carry it (its
   * `employees` is the trial roster's size, and a licence-only install does not check in), so null.
   */
  agentsInUse: number | null;
  /** Whole phone minutes booked this calendar month (UTC), per part. */
  minutesThisMonth: { incoming: number; landline: number; mobile: number };
};

/** The first moment of the calendar month (UTC) that `now` is in. */
function monthStart(now: number): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

function minutesThisMonth(
  ledger: LedgerEntry[],
  customerId: string,
  now: number,
): CustomerRow["minutesThisMonth"] {
  const from = monthStart(now);
  const minutes = { incoming: 0, landline: 0, mobile: 0 };
  for (const entry of ledger) {
    if (entry.customerId !== customerId || Date.parse(entry.at) < from)
      continue;
    if (
      entry.kind === "incoming" ||
      entry.kind === "landline" ||
      entry.kind === "mobile"
    ) {
      minutes[entry.kind] += entry.minutes;
    }
  }
  return minutes;
}

const TIERS = [5, 10, 20];

function activeLicence(licences: Licence[]): Licence | null {
  return (
    licences
      .filter((licence) => licence.status === "active")
      .sort((a, b) =>
        (b.periodEnd ?? "").localeCompare(a.periodEnd ?? ""),
      )[0] ?? null
  );
}

export function customerRows(data: CheckinExport, now: number): CustomerRow[] {
  const ids = new Set<string>();
  for (const install of data.installs) ids.add(install.customerId);
  for (const licence of data.licences)
    if (licence.customerId) ids.add(licence.customerId);
  for (const account of data.phone) ids.add(account.customerId);
  return [...ids].sort().map((customerId) => {
    const installs = data.installs
      .filter((install) => install.customerId === customerId)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    const licence = activeLicence(
      data.licences.filter((row) => row.customerId === customerId),
    );
    const trials = installs.filter(
      (install) => install.status === "trial" && install.daysLeft > 0,
    );
    const plan: Plan =
      licence || installs.some((install) => install.status === "paid")
        ? "paid"
        : trials.length > 0
          ? "trial"
          : "ended";
    // The install heard from last has the freshest view of the customer's one trial; an install
    // silent for days still reports the days left it had then.
    const freshest = trials[0];
    const team = licence?.plan === "team" ? licence : null;
    const tierNamed = TIERS.includes(team?.maxAgents ?? 0);
    const agentsPerSeat = team
      ? tierNamed
        ? (team.maxAgents as number)
        : 5
      : null;
    const seats = licence?.seats ?? null;
    return {
      agentsPerSeat,
      tierNamed,
      seats,
      maxAgents: agentsPerSeat === null ? null : agentsPerSeat * (seats ?? 1),
      agentsInUse: null,
      minutesThisMonth: minutesThisMonth(data.ledger, customerId, now),
      customerId,
      installs,
      version: installs[0]?.version ?? null,
      plan,
      planName: licence?.plan ?? null,
      addons: licence?.addons ?? [],
      daysLeft: plan === "trial" ? (freshest?.daysLeft ?? null) : null,
      endsAt:
        plan === "trial"
          ? (freshest?.endsAt ?? null)
          : (licence?.periodEnd ?? null),
      phone:
        data.phone.find((account) => account.customerId === customerId) ?? null,
      lastSeen: installs[0]?.lastSeen ?? null,
      silentInstalls: installs.filter(
        (install) => now - Date.parse(install.lastSeen) > SILENT_MS,
      ).length,
      severalInstalls:
        installs.filter(
          (install) => now - Date.parse(install.lastSeen) < 7 * 86_400_000,
        ).length > 1,
    };
  });
}

export type Overview = {
  installs: number;
  customers: number;
  trial: number;
  paid: number;
  ended: number;
  endingSoon: number;
  silentInstalls: number;
  phoneLow: number;
  /** Customers with an active Ark Team licence, per tier (agents per seat; no tier counts as 5). */
  perTier: { 5: number; 10: number; 20: number };
  /** Phone usage events waiting for Stripe's meters. Null when the export does not say. */
  meterEventsWaiting: number | null;
};

export function overview(data: CheckinExport, now: number): Overview {
  const rows = customerRows(data, now);
  return {
    installs: data.installs.length,
    customers: rows.length,
    trial: rows.filter((row) => row.plan === "trial").length,
    paid: rows.filter((row) => row.plan === "paid").length,
    ended: rows.filter((row) => row.plan === "ended").length,
    endingSoon: rows.filter(
      (row) =>
        row.plan === "trial" &&
        row.daysLeft !== null &&
        row.daysLeft <= ENDING_DAYS,
    ).length,
    silentInstalls: data.installs.filter(
      (install) => now - Date.parse(install.lastSeen) > SILENT_MS,
    ).length,
    phoneLow: data.phone.filter((account) => account.state !== "ok").length,
    perTier: {
      5: rows.filter((row) => row.agentsPerSeat === 5).length,
      10: rows.filter((row) => row.agentsPerSeat === 10).length,
      20: rows.filter((row) => row.agentsPerSeat === 20).length,
    },
    meterEventsWaiting: data.meterEventsWaiting ?? null,
  };
}

export type TimelineEvent =
  | { at: string; kind: "first-checkin"; install: Install }
  | { at: string; kind: "last-checkin"; install: Install }
  | { at: string; kind: "trial-ends"; install: Install }
  | { at: string; kind: "licence"; licence: Licence }
  | { at: string; kind: "phone"; entry: LedgerEntry }
  | {
      at: string;
      kind: "case";
      number: number;
      subject: string;
      status: string;
    };

/** Everything known about one customer, newest first. */
export function timeline(
  data: CheckinExport,
  customerId: string,
  extra: TimelineEvent[] = [],
): TimelineEvent[] {
  const events: TimelineEvent[] = [...extra];
  for (const install of data.installs.filter(
    (row) => row.customerId === customerId,
  )) {
    events.push({ at: install.firstSeen, kind: "first-checkin", install });
    if (install.lastSeen !== install.firstSeen) {
      events.push({ at: install.lastSeen, kind: "last-checkin", install });
    }
    if (install.status === "trial" && install.endsAt) {
      events.push({ at: install.endsAt, kind: "trial-ends", install });
    }
  }
  for (const licence of data.licences.filter(
    (row) => row.customerId === customerId,
  )) {
    events.push({ at: licence.updatedAt, kind: "licence", licence });
  }
  for (const entry of data.ledger.filter(
    (row) => row.customerId === customerId,
  )) {
    events.push({ at: entry.at, kind: "phone", entry });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
