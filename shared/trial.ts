/**
 * A customer trial, as BlackArk signs it (#109, v0.1.37).
 *
 * TWO THINGS ARE SIGNED. A trial profile (`<customer>.arktrial`) says who the customer is, the fixed
 * first and last day, the plan, the digital employees to set up and whether making more is blocked.
 * An unlock code says what changes for that customer afterwards: a later end, an end now, or paid.
 *
 * WHY FIXED DATES. The profile carries the start and the end, not "30 days from import", so wiping
 * the data and importing the file again starts nothing new: the end is where it always was.
 *
 * WHAT IS SIGNED IS THE ENCODED TEXT. A profile file holds the profile as base64url JSON and the
 * Ed25519 signature over exactly those characters, so nothing has to agree on how to lay out JSON
 * before a signature can be checked. Reading and checking the shape lives here (the app shows it);
 * checking the signature needs `node:crypto` and lives in `trial-sign.ts`.
 */
import { type PlanId, planById } from "./plans";

export const PROFILE_FORMAT = "arktrial/1";
/** What an unlock code starts with, so a person pasting the wrong thing is told so at once. */
export const CODE_PREFIX = "ARK1-";

export type RosterEntry = {
  /** Lower-case letters, numbers and hyphens. Unique in the roster; how a re-import knows it. */
  key: string;
  name: string;
  title: string;
  roleDescription: string;
  /** The standing instruction the employee works to, in the language it should speak. */
  instructions: string;
  /** An official role whose skills come with it, by its marketplace slug. */
  basedOn?: string;
  /** The one who leads the team. The first entry when none says so. */
  lead?: boolean;
  /**
   * Gets the customer's mailbox (from v0.1.38): read, search, draft, and send behind an approval
   * card. `folders` limits what it may read (absent: the whole mailbox); `from` is the address it
   * sends as (absent: the mailbox's own).
   */
  mail?: { folders?: string[]; from?: string };
  /** Looks prices up in the business's uploaded price list (from v0.1.40), and nowhere else. */
  priceList?: boolean;
  /** Edits video on this computer from the business's own files (from v0.1.40). */
  video?: boolean;
  /**
   * Business connectors this employee may use (from v0.1.43): any of `skroutz`, `woocommerce`,
   * `boxnow`, `business-files`. The accounts themselves are connected at setup in Settings.
   */
  connectors?: RosterConnector[];
};

export const ROSTER_CONNECTORS = [
  "skroutz",
  "woocommerce",
  "boxnow",
  "business-files",
] as const;
export type RosterConnector = (typeof ROSTER_CONNECTORS)[number];

export type TrialProfile = {
  v: 1;
  customer: { id: string; name: string };
  /** When BlackArk signed it. A newer profile for the same customer replaces an older one. */
  issuedAt: string;
  startsAt: string;
  endsAt: string;
  plan: PlanId;
  /** No digital employees beyond the roster while the trial lasts. */
  createBlocked: boolean;
  /** Where the app reports its trial status once a day. Absent: it reports nowhere. */
  checkInUrl?: string;
  /** Refuse any outgoing email with an AMKA-shaped (11-digit) number in it . */
  mailBlockAmka?: boolean;
  /**
   * Paid add-ons BlackArk switched on for this customer, signed like the rest. "phone": answering
   * the business's phone line. Absent: none, and the add-on stays off on this install.
   */
  addons?: TrialAddon[];
  roster: RosterEntry[];
};

export const TRIAL_ADDONS = ["phone"] as const;
export type TrialAddon = (typeof TRIAL_ADDONS)[number];

export type UnlockAction = "extend" | "end" | "paid";

export type UnlockCode = {
  v: 1;
  customer: string;
  /** Random, so each code works once. */
  nonce: string;
  action: UnlockAction;
  /** For `extend`: the new last moment of the trial. */
  until?: string;
  issuedAt: string;
};

/** The file a profile travels in. */
export type ProfileFile = {
  format: typeof PROFILE_FORMAT;
  profile: string;
  signature: string;
};

export class TrialFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrialFormatError";
  }
}

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CUSTOMER = /^[a-z0-9][a-z0-9-]{1,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TrialFormatError(`The trial profile has no ${field}.`);
  }
  if (value.length > max) {
    throw new TrialFormatError(`The trial profile's ${field} is too long.`);
  }
  return value.trim();
}

function instant(value: unknown, field: string): string {
  const raw = text(value, field, 40);
  const time = Date.parse(raw);
  if (Number.isNaN(time)) {
    throw new TrialFormatError(`The trial profile's ${field} is not a date.`);
  }
  return new Date(time).toISOString();
}

export function encodeBase64Url(textValue: string): string {
  const bytes = new TextEncoder().encode(textValue);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(encoded: string): string {
  if (!BASE64URL.test(encoded)) throw new TrialFormatError("Not base64url.");
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function json(encoded: string, what: string): unknown {
  try {
    return JSON.parse(decodeBase64Url(encoded));
  } catch {
    throw new TrialFormatError(`This is not a readable ${what}.`);
  }
}

/** The profile's shape, checked. Says nothing about who signed it. */
export function readProfile(value: unknown): TrialProfile {
  if (!value || typeof value !== "object") {
    throw new TrialFormatError("This is not a trial profile.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) {
    throw new TrialFormatError(
      "This trial profile is for a different version of ArkAgent.",
    );
  }
  const customer = raw.customer as Record<string, unknown> | undefined;
  const customerId = text(customer?.id, "customer id", 64);
  if (!CUSTOMER.test(customerId)) {
    throw new TrialFormatError("The trial profile's customer id is not valid.");
  }
  const startsAt = instant(raw.startsAt, "start");
  const endsAt = instant(raw.endsAt, "end");
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new TrialFormatError("The trial profile ends before it starts.");
  }
  const plan = text(raw.plan, "plan", 32);
  if (!planById(plan) || plan === "internal") {
    throw new TrialFormatError("The trial profile names an unknown plan.");
  }
  if (typeof raw.createBlocked !== "boolean") {
    throw new TrialFormatError(
      "The trial profile does not say whether making employees is blocked.",
    );
  }
  let checkInUrl: string | undefined;
  if (raw.checkInUrl !== undefined && raw.checkInUrl !== null) {
    const url = text(raw.checkInUrl, "check-in address", 500);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TrialFormatError(
        "The trial profile's check-in address is not valid.",
      );
    }
    if (parsed.protocol !== "https:") {
      throw new TrialFormatError(
        "The trial profile's check-in address must start with https://.",
      );
    }
    checkInUrl = parsed.toString();
  }
  if (!Array.isArray(raw.roster) || raw.roster.length > 100) {
    throw new TrialFormatError(
      "The trial profile's list of employees is not valid.",
    );
  }
  const keys = new Set<string>();
  const roster = raw.roster.map((item: unknown): RosterEntry => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const key = text(entry.key, "employee key", 40);
    if (!KEY.test(key) || keys.has(key)) {
      throw new TrialFormatError(
        `The trial profile's employee key "${key}" is not valid or is used twice.`,
      );
    }
    keys.add(key);
    const basedOn =
      entry.basedOn === undefined ? undefined : text(entry.basedOn, "role", 64);
    let mail: RosterEntry["mail"];
    if (entry.mail !== undefined && entry.mail !== null) {
      const raw = entry.mail as Record<string, unknown>;
      if (typeof raw !== "object") {
        throw new TrialFormatError(
          `The trial profile's mail settings for "${key}" are not valid.`,
        );
      }
      const folders =
        raw.folders === undefined
          ? undefined
          : Array.isArray(raw.folders) &&
              raw.folders.length > 0 &&
              raw.folders.length <= 20
            ? raw.folders.map((folder) => text(folder, "mail folder", 200))
            : (() => {
                throw new TrialFormatError(
                  `The trial profile's mail folders for "${key}" are not valid.`,
                );
              })();
      const from =
        raw.from === undefined
          ? undefined
          : text(raw.from, "mail address", 254);
      if (
        from !== undefined &&
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)
      ) {
        throw new TrialFormatError(
          `The trial profile's mail address for "${key}" is not valid.`,
        );
      }
      mail = { ...(folders ? { folders } : {}), ...(from ? { from } : {}) };
    }
    return {
      key,
      name: text(entry.name, "employee name", 80),
      title: text(entry.title, "employee title", 120),
      roleDescription: text(entry.roleDescription, "role description", 600),
      instructions: text(entry.instructions, "standing instruction", 20_000),
      ...(basedOn ? { basedOn } : {}),
      ...(entry.lead === true ? { lead: true } : {}),
      ...(mail ? { mail } : {}),
      ...(entry.priceList === true ? { priceList: true } : {}),
      ...(entry.video === true ? { video: true } : {}),
      ...connectorsFrom(entry.connectors, key),
    };
  });
  return {
    v: 1,
    customer: {
      id: customerId,
      name: text(customer?.name, "customer name", 120),
    },
    issuedAt: instant(raw.issuedAt, "issue date"),
    startsAt,
    endsAt,
    plan: plan as PlanId,
    createBlocked: raw.createBlocked,
    ...(checkInUrl ? { checkInUrl } : {}),
    ...(raw.mailBlockAmka === true ? { mailBlockAmka: true } : {}),
    ...addonsFrom(raw.addons),
    roster,
  };
}

/** Known connectors only, each once; a typo is refused rather than signed silently. */
function connectorsFrom(
  value: unknown,
  key: string,
): { connectors?: RosterConnector[] } {
  if (value === undefined) return {};
  if (
    !Array.isArray(value) ||
    value.some((name) => !ROSTER_CONNECTORS.includes(name as RosterConnector))
  ) {
    throw new TrialFormatError(
      `The trial profile's connectors for "${key}" are not valid. Known: ${ROSTER_CONNECTORS.join(", ")}.`,
    );
  }
  const unique = [...new Set(value as RosterConnector[])];
  return unique.length > 0 ? { connectors: unique } : {};
}

/** Known add-ons only, each once; an unknown name is refused so a typo is not signed silently. */
function addonsFrom(value: unknown): { addons?: TrialAddon[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new TrialFormatError(
      'The add-ons must be a list, for example ["phone"].',
    );
  }
  const addons: TrialAddon[] = [];
  for (const name of value) {
    if (!TRIAL_ADDONS.includes(name as TrialAddon)) {
      throw new TrialFormatError(`There is no add-on called ${String(name)}.`);
    }
    if (!addons.includes(name as TrialAddon)) addons.push(name as TrialAddon);
  }
  return addons.length > 0 ? { addons } : {};
}

/** A profile file's text, split into what was signed and the signature. Shape only. */
export function readProfileFile(fileText: string): {
  file: ProfileFile;
  profile: TrialProfile;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new TrialFormatError("This file is not a trial profile.");
  }
  const raw = (parsed ?? {}) as Record<string, unknown>;
  if (
    raw.format !== PROFILE_FORMAT ||
    typeof raw.profile !== "string" ||
    typeof raw.signature !== "string" ||
    !BASE64URL.test(raw.profile) ||
    !BASE64URL.test(raw.signature)
  ) {
    throw new TrialFormatError("This file is not a trial profile.");
  }
  const file: ProfileFile = {
    format: PROFILE_FORMAT,
    profile: raw.profile,
    signature: raw.signature,
  };
  return { file, profile: readProfile(json(raw.profile, "trial profile")) };
}

/** An unlock code as typed or pasted, split and shape-checked. Says nothing about who signed it. */
export function readUnlockCode(typed: string): {
  payload: string;
  signature: string;
  code: UnlockCode;
} {
  const compact = typed.replace(/\s+/g, "");
  if (!compact.startsWith(CODE_PREFIX)) {
    throw new TrialFormatError("This is not an unlock code.");
  }
  const [payload, signature, extra] = compact
    .slice(CODE_PREFIX.length)
    .split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new TrialFormatError("This is not an unlock code.");
  }
  const raw = (json(payload, "unlock code") ?? {}) as Record<string, unknown>;
  const action = raw.action;
  if (
    raw.v !== 1 ||
    typeof raw.customer !== "string" ||
    typeof raw.nonce !== "string" ||
    raw.nonce.length < 8 ||
    raw.nonce.length > 64 ||
    (action !== "extend" && action !== "end" && action !== "paid") ||
    typeof raw.issuedAt !== "string" ||
    Number.isNaN(Date.parse(raw.issuedAt))
  ) {
    throw new TrialFormatError("This is not an unlock code.");
  }
  let until: string | undefined;
  if (action === "extend") {
    if (typeof raw.until !== "string" || Number.isNaN(Date.parse(raw.until))) {
      throw new TrialFormatError("This is not an unlock code.");
    }
    until = new Date(Date.parse(raw.until)).toISOString();
  }
  return {
    payload,
    signature,
    code: {
      v: 1,
      customer: raw.customer,
      nonce: raw.nonce,
      action,
      ...(until ? { until } : {}),
      issuedAt: new Date(Date.parse(raw.issuedAt)).toISOString(),
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

/** Whole days the trial was set for, as the customer is told it: 30, not 29.99. */
export function trialLengthDays(startsAt: string, endsAt: string): number {
  return Math.max(
    1,
    Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / DAY),
  );
}

/** Days left, counting a part day as a day; zero once it has ended. */
export function trialDaysLeftAt(endsAt: string, now: Date): number {
  const left = Date.parse(endsAt) - now.getTime();
  return left <= 0 ? 0 : Math.ceil(left / DAY);
}
