/**
 * Activating ArkAgent on a computer (#109, v0.1.42): a trial activation code or a paid licence key.
 *
 * WHY. Amgad, 16 Nov: nobody uses the app without one of the two. A trial user types the trial
 * activation code BlackArk gave them; a paying user types the licence key they got after paying. The
 * trial setup file (`.arktrial`) that DT Lab imports in the setup session counts as a trial too.
 *
 * ONE BOX FOR BOTH. Both are `ARK1-` codes, like the unlock codes, so the person has one field to type
 * into and the app tells them which it was. What is inside says which:
 *
 * - `action: "trial"`: a trial for this customer until a fixed moment, signed with the trial key. A
 *   fixed end, not "30 days from now", so typing it again on a wiped computer starts nothing new.
 * - `action: "license"`: paid, until `validUntil` (the paid period's end plus a week's grace), signed
 *   with the licence key. Not single use: the same key works again after a reinstall. Each renewal
 *   is a new key with a later `validUntil`, fetched by the app from `renewUrl` once a day.
 *
 * Shape only here; the signature is checked on the server (`trial-sign.ts` needs `node:crypto`).
 */
import { type PlanId, planById } from "./plans";
import {
  CODE_PREFIX,
  decodeBase64Url,
  TRIAL_ADDONS,
  type TrialAddon,
  TrialFormatError,
} from "./trial";

export type TrialActivation = {
  v: 1;
  action: "trial";
  customer: string;
  nonce: string;
  issuedAt: string;
  /** The last moment of the trial. */
  until: string;
  plan: PlanId;
  addons?: TrialAddon[];
};

export type LicenseKey = {
  v: 1;
  action: "license";
  customer: string;
  /** Random per key: what the renewal server calls this key. */
  nonce: string;
  issuedAt: string;
  plan: PlanId;
  /** How many computers the customer paid for. This computer is one; the count is BlackArk's. */
  seats: number;
  /** The paid period's end plus the grace, after which the app asks for a key again. */
  validUntil: string;
  addons?: TrialAddon[];
  /** Where the app asks once a day for the renewed key. Absent: it asks nowhere. */
  renewUrl?: string;
};

export type ActivationCode = TrialActivation | LicenseKey;

const CUSTOMER = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Days of grace after a paid period ends, built into each key's `validUntil` when it is signed. */
export const LICENSE_GRACE_DAYS = 7;

function moment(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TrialFormatError("This is not an activation code.");
  }
  return new Date(Date.parse(value)).toISOString();
}

function addons(value: unknown): { addons?: TrialAddon[] } {
  if (value === undefined) return {};
  if (
    !Array.isArray(value) ||
    value.some((name) => !TRIAL_ADDONS.includes(name as TrialAddon))
  ) {
    throw new TrialFormatError("This activation code names an unknown add-on.");
  }
  const unique = [...new Set(value as TrialAddon[])];
  return unique.length > 0 ? { addons: unique } : {};
}

/** The action inside an `ARK1-` code, without checking anything else, or null if unreadable. */
export function codeAction(typed: string): string | null {
  const compact = typed.replace(/\s+/g, "");
  if (!compact.startsWith(CODE_PREFIX)) return null;
  const payload = compact.slice(CODE_PREFIX.length).split(".")[0] ?? "";
  try {
    const raw = JSON.parse(decodeBase64Url(payload)) as { action?: unknown };
    return typeof raw.action === "string" ? raw.action : null;
  } catch {
    return null;
  }
}

/** A trial activation code or a licence key, split and shape-checked. Says nothing about who signed it. */
export function readActivationCode(typed: string): {
  payload: string;
  signature: string;
  code: ActivationCode;
} {
  const compact = typed.replace(/\s+/g, "");
  if (!compact.startsWith(CODE_PREFIX)) {
    throw new TrialFormatError("This is not an activation code.");
  }
  const [payload, signature, extra] = compact
    .slice(CODE_PREFIX.length)
    .split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new TrialFormatError("This is not an activation code.");
  }
  let raw: Record<string, unknown>;
  try {
    raw = (JSON.parse(decodeBase64Url(payload)) ?? {}) as Record<
      string,
      unknown
    >;
  } catch {
    throw new TrialFormatError("This is not an activation code.");
  }
  if (
    raw.v !== 1 ||
    typeof raw.customer !== "string" ||
    !CUSTOMER.test(raw.customer) ||
    typeof raw.nonce !== "string" ||
    raw.nonce.length < 8 ||
    raw.nonce.length > 64 ||
    typeof raw.plan !== "string" ||
    !planById(raw.plan)
  ) {
    throw new TrialFormatError("This is not an activation code.");
  }
  const common = {
    v: 1 as const,
    customer: raw.customer,
    nonce: raw.nonce,
    issuedAt: moment(raw.issuedAt),
    plan: raw.plan as PlanId,
    ...addons(raw.addons),
  };
  if (raw.action === "trial") {
    if (raw.plan === "internal") {
      throw new TrialFormatError("This is not an activation code.");
    }
    return {
      payload,
      signature,
      code: { ...common, action: "trial", until: moment(raw.until) },
    };
  }
  if (raw.action === "license") {
    const seats = raw.seats;
    if (
      typeof seats !== "number" ||
      !Number.isInteger(seats) ||
      seats < 1 ||
      seats > 10_000
    ) {
      throw new TrialFormatError("This is not an activation code.");
    }
    let renewUrl: string | undefined;
    if (raw.renewUrl !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(String(raw.renewUrl));
      } catch {
        throw new TrialFormatError("This is not an activation code.");
      }
      if (parsed.protocol !== "https:") {
        throw new TrialFormatError("This is not an activation code.");
      }
      renewUrl = parsed.toString();
    }
    return {
      payload,
      signature,
      code: {
        ...common,
        action: "license",
        seats,
        validUntil: moment(raw.validUntil),
        ...(renewUrl ? { renewUrl } : {}),
      },
    };
  }
  throw new TrialFormatError("This is not an activation code.");
}
