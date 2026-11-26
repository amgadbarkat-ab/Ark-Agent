/**
 * Whether this install is activated (#109, v0.1.42): a trial activation code, a paid licence key, or
 * the trial setup file. Amgad, 16 Nov: no access without one of the two.
 *
 * REQUIRED ON A DESKTOP INSTALL ONLY. The desktop app starts the server with
 * `ARK_ACTIVATION_REQUIRED=true`; a hosted deployment, a developer's machine and CI leave it unset,
 * and there nothing here changes anything until a code is typed.
 *
 * WHAT COUNTS, FIRST MATCH WINS:
 * 1. A paid licence key whose `validUntil` has not passed.
 * 2. The trial setup file (`trial_state`), converted to paid by an unlock code, or still running.
 * 3. A trial activation code whose end has not passed.
 * Otherwise the install is not activated, or its trial ended, or its licence expired: the app shows
 * the Activate screen and nothing runs. Conversations, employees and settings are kept.
 *
 * THE CLOCK. Every end is compared with the later of the computer's clock and the latest time this
 * install has seen, as for the trial, so turning the clock back does not bring a key back.
 *
 * FETCHING THE KEY (v0.1.44 renewal; v0.1.49 also before there is one). The install asks
 * blackark.uk (the key's `renewUrl`, or `checkin/renew/`) for its licence key: on start-up, every
 * five minutes while on a trial or waiting on Activate, every 20 seconds for 30 minutes after the
 * buy page is opened from the app, and once a day when paid. It sends the customer id, this
 * install's random id, the version, the end and number of the key in hand, and BlackArk's own proof
 * that this is that customer's install (its signed trial setup file, activation code or licence key,
 * exactly as BlackArk issued it; install-proof.ts). Nothing else: no conversation, name or file. A
 * key that comes back is applied exactly as a typed key is, so a payment unlocks the app by itself.
 */
import { type KeyObject, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type ActivationCode,
  codeAction,
  readActivationCode,
} from "../../../shared/activation";
import {
  agentLimitFor,
  DEFAULT_AGENTS_PER_SEAT,
  planById,
  planHasAgentTiers,
} from "../../../shared/plans";
import {
  CODE_PREFIX,
  type TrialAddon,
  TrialFormatError,
} from "../../../shared/trial";
import { selfServeTrialShapeOk } from "../../../shared/trial-public-key";
import { signedByAny } from "../../../shared/trial-sign";
import type { Entitlement } from "../accounts/store";
import type { Database } from "../db/client";
import { activationState } from "../db/schema";
import { installIdentity } from "./install-proof";
import {
  TrialRefusedError,
  type TrialService,
  type TrialView,
} from "./service";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export type ActivationState = "none" | "trial" | "paid" | "ended" | "expired";

export type ActivationView = {
  /** Whether this install must be activated before anything runs. */
  required: boolean;
  /** Whether it may be used now: activated, or not required. */
  allowed: boolean;
  state: ActivationState;
  /** What decided `state`. */
  source: "license" | "trial-code" | "trial-profile" | null;
  customerId: string | null;
  /** From the trial setup file only; a code carries no name. */
  customerName: string | null;
  planId: string | null;
  planName: string | null;
  /** The trial's end, or the licence's last valid moment. Null for paid with no end. */
  until: string | null;
  daysLeft: number | null;
  seats: number | null;
  /**
   * Ark Team's tier (v0.1.49): digital employees per seat from the licence key, 5 for a team key
   * without one or a team trial code. Null for every other plan and for the trial setup file.
   */
  agentsPerSeat: number | null;
  /** How many digital employees this install may have (agent-limit.ts). Null: no limit. */
  agentLimit: number | null;
  addons: TrialAddon[];
  /** The renewal host only. */
  renewHost: string | null;
  lastRenewAt: string | null;
  lastRenewError: string | null;
  /** Whether this build can check each kind of signature at all. */
  keys: { trial: boolean; license: boolean };
  /**
   * BlackArk's buy page for this install's customer (v0.1.49), while there is something to buy:
   * activation is required, the customer is known, and it is not paid. Null otherwise.
   */
  buyUrl: string | null;
  /** Whether a free trial can be started here by email (v0.1.58): self-serve, nothing activated yet. */
  selfServeTrial: boolean;
  /** When a key fetched after a payment activated this install, since the server started. */
  paymentReceivedAt: string | null;
};

/** Where an install asks for its licence key when the key it has names none, or it has none yet. */
export const DEFAULT_LICENSE_URL = "https://blackark.uk/checkin/renew/";
/** BlackArk's buy page (infra/blackark-checkin/checkin/buy/), opened with the customer id. */
export const DEFAULT_BUY_URL = "https://blackark.uk/checkin/buy/";

/** After the buy page opens, ask this often for this long (Amgad, 19 Nov: no manual step). */
const FAST_EVERY = 20 * 1000;
const FAST_FOR = 30 * MINUTE;
/** While on a trial or waiting on Activate. */
const SLOW_EVERY = 5 * MINUTE;

/**
 * Whether to ask blackark.uk for the key now (v0.1.49): on start-up; every 20 seconds for 30 minutes
 * after the buy page opened; every five minutes while not paid; once paid, once a day as before, and
 * hourly after a failure.
 */
export function keyFetchDue(state: {
  paid: boolean;
  lastAttemptAt: Date | null;
  lastRenewAt: Date | null;
  failed: boolean;
  fastUntil: Date | null;
  now: Date;
}): boolean {
  const now = state.now.getTime();
  const since = (at: Date | null) =>
    at ? now - at.getTime() : Number.POSITIVE_INFINITY;
  if (state.paid) {
    if (state.failed) return since(state.lastAttemptAt) >= 60 * MINUTE;
    return since(state.lastRenewAt) >= DAY - 5 * MINUTE;
  }
  const fast = state.fastUntil !== null && now < state.fastUntil.getTime();
  return since(state.lastAttemptAt) >= (fast ? FAST_EVERY : SLOW_EVERY);
}

export type AppliedCode = {
  kind: "trial" | "license" | "extend" | "end" | "paid";
  /** False when the same key, or an older one, was typed again. */
  changed: boolean;
  activation: ActivationView;
};

type Row = typeof activationState.$inferSelect;

export const NOT_ACTIVATED_MESSAGE =
  "ArkAgent is not activated on this computer. Enter your trial activation code or your licence key.";

function addonsOf(row: Row | undefined): TrialAddon[] {
  return row?.addons ? (row.addons.split(",") as TrialAddon[]) : [];
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The tier a stored code carries (v0.1.49), read back from its signed payload so no new column is
 * needed: 5, 10 or 20 for a team key that names it, the default 5 for a team key or trial code that
 * does not, null for every other plan.
 */
function agentsPerSeatOf(row: Row): number | null {
  if (!planHasAgentTiers(row.planId)) return null;
  try {
    const { code } = readActivationCode(
      `${CODE_PREFIX}${row.payload}.${row.signature}`,
    );
    if (code.action === "license" && code.maxAgents) return code.maxAgents;
  } catch {
    // A row this build wrote itself is always readable; the default is the safe answer anyway.
  }
  return DEFAULT_AGENTS_PER_SEAT;
}

export type ActivationService = ReturnType<typeof createActivationService>;

export function createActivationService(
  database: Database,
  options: {
    required: boolean;
    trialKeys: readonly KeyObject[];
    licenseKeys: readonly KeyObject[];
    /**
     * blackark.uk's self-serve trial keys (v0.1.58): trusted only for a short Ark Team trial code
     * (`selfServeTrialShapeOk`), never for anything else.
     */
    selfServeKeys?: readonly KeyObject[];
    /** Where a self-serve trial is started (blackark.uk's checkin/trial/). */
    trialUrl?: string;
    trial: TrialService;
    version: string;
    now?: () => Date;
    fetch?: typeof fetch;
    /** Where to ask for the key when the key in hand names no renewal address (v0.1.49). */
    licenseUrl?: string;
    buyUrl?: string;
    /** How often the scheduler looks whether asking is due; tests make it short. */
    tickMs?: number;
  },
) {
  const { trial } = options;
  const now = options.now ?? (() => new Date());
  const send = options.fetch ?? fetch;
  const licenseUrl = options.licenseUrl ?? DEFAULT_LICENSE_URL;
  const buyUrl = options.buyUrl ?? DEFAULT_BUY_URL;
  const trialUrl = options.trialUrl ?? new URL("../trial/", buyUrl).toString();
  /** A self-serve trial being started: the email the code went to, and this install's id for it. */
  let selfServePending: {
    email: string;
    installId: string;
    at: number;
  } | null = null;
  /** In memory: since this server started. A restart asks again at once, which is what is wanted. */
  const fetching = {
    lastAttemptAt: null as Date | null,
    lastError: null as string | null,
    lastSuccessAt: null as Date | null,
    fastUntil: null as Date | null,
    paymentReceivedAt: null as Date | null,
  };

  async function load(): Promise<Row | undefined> {
    const [row] = await database.select().from(activationState).limit(1);
    return row;
  }

  /** The later of the clock and what this install has seen, remembered as it moves forward. */
  async function seenNow(row: Row | undefined): Promise<Date> {
    const clock = now();
    if (!row) return clock;
    if (clock.getTime() > row.latestSeenAt.getTime() + MINUTE) {
      await database
        .update(activationState)
        .set({ latestSeenAt: clock })
        .where(eq(activationState.id, row.id));
      return clock;
    }
    return clock.getTime() > row.latestSeenAt.getTime()
      ? clock
      : row.latestSeenAt;
  }

  function daysLeft(until: Date, at: Date): number {
    const left = until.getTime() - at.getTime();
    return left <= 0 ? 0 : Math.ceil(left / DAY);
  }

  async function resolve(): Promise<{
    view: ActivationView;
    row: Row | undefined;
    profile: TrialView | null;
  }> {
    const [row, profile] = await Promise.all([load(), trial.current()]);
    const at = await seenNow(row);
    let renewHost: string | null = null;
    try {
      renewHost = row?.renewUrl ? new URL(row.renewUrl).host : null;
    } catch {
      renewHost = null;
    }
    const base = {
      required: options.required,
      seats: null as number | null,
      agentsPerSeat: null as number | null,
      agentLimit: null as number | null,
      addons: [] as TrialAddon[],
      renewHost,
      // A licence key keeps its renewal on file; before there is one, what this server last heard.
      lastRenewAt:
        (row?.kind === "license"
          ? row.lastRenewAt
          : fetching.lastSuccessAt
        )?.toISOString() ?? null,
      lastRenewError:
        (row?.kind === "license" ? row.lastRenewError : fetching.lastError) ??
        null,
      keys: {
        trial: options.trialKeys.length > 0,
        license: options.licenseKeys.length > 0,
      },
      buyUrl: null as string | null,
      selfServeTrial: false,
      paymentReceivedAt: fetching.paymentReceivedAt?.toISOString() ?? null,
    };
    const fromRow = (state: ActivationState) => ({
      ...base,
      allowed: state === "trial" || state === "paid" || !options.required,
      state,
      source:
        row?.kind === "license"
          ? ("license" as const)
          : ("trial-code" as const),
      customerId: row?.customerId ?? null,
      customerName:
        profile?.customerId === row?.customerId
          ? (profile?.customerName ?? null)
          : null,
      planId: row?.planId ?? null,
      planName: row ? (planById(row.planId)?.name ?? row.planId) : null,
      until: row?.validUntil.toISOString() ?? null,
      daysLeft: row ? daysLeft(row.validUntil, at) : null,
      seats: row?.seats ?? null,
      agentsPerSeat: row ? agentsPerSeatOf(row) : null,
      agentLimit: row
        ? agentLimitFor({
            planId: row.planId,
            agentsPerSeat: agentsPerSeatOf(row),
            seats: row.seats,
          })
        : null,
      addons: addonsOf(row),
    });
    const fromProfile = (state: ActivationState, view: TrialView) => ({
      ...base,
      allowed: state === "trial" || state === "paid" || !options.required,
      state,
      source: "trial-profile" as const,
      customerId: view.customerId,
      customerName: view.customerName,
      planId: view.planId,
      planName: view.planName,
      until: view.status === "paid" ? null : view.endsAt,
      daysLeft: view.status === "paid" ? null : view.daysLeft,
      // The signed roster's own size, or 5 when it names nobody (Amgad's brief, 19 Nov).
      agentLimit: planHasAgentTiers(view.planId)
        ? view.rosterSize > 0
          ? view.rosterSize
          : DEFAULT_AGENTS_PER_SEAT
        : null,
    });
    const rowActive = row ? at.getTime() < row.validUntil.getTime() : false;
    let view: ActivationView;
    if (row?.kind === "license" && rowActive) view = fromRow("paid");
    else if (profile?.status === "paid") view = fromProfile("paid", profile);
    else if (profile?.status === "trial") view = fromProfile("trial", profile);
    else if (row?.kind === "trial" && rowActive) view = fromRow("trial");
    else if (row?.kind === "license") view = fromRow("expired");
    else if (profile) view = fromProfile("ended", profile);
    else if (row) view = fromRow("ended");
    else {
      view = {
        ...base,
        allowed: !options.required,
        state: "none",
        source: null,
        customerId: null,
        customerName: null,
        planId: null,
        planName: null,
        until: null,
        daysLeft: null,
      };
    }
    view.selfServeTrial =
      options.required &&
      view.state === "none" &&
      (options.selfServeKeys?.length ?? 0) > 0;
    if (options.required && view.customerId && view.state !== "paid") {
      // The existing buy page (buy/index.php): the plan, and the phone add-on when this install's
      // trial carries it, so the customer pays for what they tried in one checkout.
      const phone =
        view.addons.includes("phone") || (await trial.addonEnabled("phone"));
      view.buyUrl = `${buyUrl}?customer=${encodeURIComponent(view.customerId)}${phone ? "&phone=1" : ""}`;
    }
    return { view, row, profile };
  }

  /**
   * The buy link signed by blackark.uk for this install (v0.1.57; the independent assessment of 26
   * Nov, F1): the buy page carries the customer id to Stripe and the licence key is made for it, so
   * blackark.uk signs a link only after checking this install's proof (buy/link/). Null when it
   * cannot, as before blackark.uk has the new pages: the unsigned link is then used, which blackark.uk
   * accepts until `buy_requires_token` is on.
   */
  async function signedBuyUrl(
    customerId: string,
    unsigned: string,
  ): Promise<string | null> {
    const who = await installIdentity(database);
    if (!who || who.customerId !== customerId) return null;
    try {
      const response = await send(new URL("link/", buyUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: who.customerId,
          installId: who.installId,
          proof: who.proof,
          ...(unsigned.includes("&phone=1") ? { phone: true } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const body = (await response.json().catch(() => ({}))) as {
        buyUrl?: unknown;
      };
      // Only this customer's buy page, nowhere else.
      const prefix = `${buyUrl}?customer=${encodeURIComponent(customerId)}&`;
      return typeof body.buyUrl === "string" &&
        body.buyUrl.length <= 400 &&
        body.buyUrl.startsWith(prefix)
        ? body.buyUrl
        : null;
    } catch {
      return null;
    }
  }

  /** One request to blackark.uk's trial page; its status and what it said. */
  async function askTrial(body: Record<string, unknown>): Promise<{
    status: number;
    error?: string;
    code?: unknown;
  }> {
    try {
      const response = await send(trialUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const parsed = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        code?: unknown;
      };
      return {
        status: response.status,
        ...(typeof parsed.error === "string"
          ? { error: parsed.error.slice(0, 300) }
          : {}),
        ...(parsed.code !== undefined ? { code: parsed.code } : {}),
      };
    } catch {
      return {
        status: 0,
        error:
          "BlackArk could not be reached. Check the internet connection and try again.",
      };
    }
  }

  async function current(): Promise<ActivationView> {
    return (await resolve()).view;
  }

  function checkSigned(
    keys: readonly KeyObject[],
    payload: string,
    signature: string,
    what: string,
  ) {
    if (keys.length === 0) {
      throw new TrialRefusedError(
        `This version of ArkAgent cannot check a ${what} yet. Ask BlackArk for the current version.`,
      );
    }
    if (!signedByAny(keys, payload, signature)) {
      throw new TrialRefusedError(`This ${what} is not signed by BlackArk.`);
    }
  }

  /** Stores a checked trial activation code or licence key. */
  async function activate(
    payload: string,
    signature: string,
    code: ActivationCode,
    quiet = false,
  ): Promise<boolean> {
    const isLicense = code.action === "license";
    const what = isLicense ? "licence key" : "trial activation code";
    const selfServe =
      !isLicense &&
      (options.selfServeKeys?.length ?? 0) > 0 &&
      !signedByAny(options.trialKeys, payload, signature) &&
      signedByAny(options.selfServeKeys ?? [], payload, signature);
    if (selfServe) {
      // A self-serve trial: only ever a short Ark Team trial (v0.1.58).
      if (!selfServeTrialShapeOk(code))
        throw new TrialRefusedError(`This ${what} is not signed by BlackArk.`);
    } else {
      checkSigned(
        isLicense ? options.licenseKeys : options.trialKeys,
        payload,
        signature,
        what,
      );
    }
    const { row, profile } = await resolve();
    const owner = profile?.customerId ?? row?.customerId;
    if (owner && owner !== code.customer) {
      throw new TrialRefusedError(
        `This ${what} is for another customer than the one this computer is set up for.`,
      );
    }
    const at = await seenNow(row);
    const until = new Date(isLicense ? code.validUntil : code.until);
    if (until.getTime() <= at.getTime()) {
      throw new TrialRefusedError(
        isLicense
          ? `This licence key expired on ${dayOf(until.toISOString())}. The renewed key is sent after each payment.`
          : `This trial activation code ended on ${dayOf(until.toISOString())}.`,
      );
    }
    if (row) {
      const rowActive = at.getTime() < row.validUntil.getTime();
      if (row.payload === payload) return false;
      if (!isLicense && row.kind === "license" && rowActive) {
        throw new TrialRefusedError(
          "This computer already has a paid licence. A trial code is not needed.",
        );
      }
      // A tier switch or a seat change (v0.1.49) re-signs the key for the same paid period: same end,
      // issued later. That one replaces the key on file; anything else that ends no later does not.
      const reissued =
        isLicense &&
        row.kind === "license" &&
        row.customerId === code.customer &&
        row.validUntil.getTime() === until.getTime() &&
        new Date(code.issuedAt).getTime() > row.issuedAt.getTime();
      if (
        row.kind === code.action &&
        row.validUntil.getTime() >= until.getTime() &&
        !reissued
      ) {
        if (quiet) return false;
        throw new TrialRefusedError(
          isLicense
            ? "This computer already has a licence key that lasts as long or longer."
            : "This computer already has a trial code that lasts as long or longer.",
        );
      }
    }
    const values = {
      // A self-serve trial keeps the install id blackark.uk saw, so its one-per-computer rule holds.
      ...(selfServe && selfServePending
        ? { installId: selfServePending.installId }
        : {}),
      kind: code.action,
      customerId: code.customer,
      payload,
      signature,
      nonce: code.nonce,
      planId: code.plan,
      seats: isLicense ? code.seats : null,
      addons: (code.addons ?? []).join(","),
      issuedAt: new Date(code.issuedAt),
      validUntil: until,
      renewUrl: isLicense ? (code.renewUrl ?? null) : null,
      lastRenewError: null,
      updatedAt: now(),
    };
    await database
      .insert(activationState)
      .values({ id: "install", ...values, latestSeenAt: at })
      .onConflictDoUpdate({ target: activationState.id, set: values });
    return true;
  }

  async function blocked(base: Entitlement, view: ActivationView) {
    if (view.state === "expired") {
      return {
        ...base,
        canRun: false,
        blockedCode: "license_expired" as const,
        blockedReason: `Your licence ended on ${dayOf(view.until ?? "")}. Your conversations and settings are kept. Enter your renewed licence key to continue.`,
      };
    }
    if (view.state === "ended") {
      return {
        ...base,
        canRun: false,
        blockedCode: "trial_ended" as const,
        blockedReason: `Your trial ended on ${dayOf(view.until ?? "")}. Your conversations and settings are kept. Enter a licence key or an unlock code to continue.`,
      };
    }
    return {
      ...base,
      canRun: false,
      blockedCode: "not_activated" as const,
      blockedReason: NOT_ACTIVATED_MESSAGE,
    };
  }

  /**
   * Asks blackark.uk for this install's licence key, and takes it if it is a newer one (v0.1.44
   * renewal; v0.1.49 also before there is a key, so a payment unlocks the app with nothing typed).
   *
   * Sent: the customer id, this install's random id, the version, the end of the key in hand (null
   * the start of time when there is none), its number, and BlackArk's own proof that this is that customer's install
   * (install-proof.ts). A key that comes back is applied exactly as a typed one: the same signature
   * check, the same customer check, the same rule that only a longer key replaces one.
   */
  async function fetchKey(): Promise<
    "activated" | "renewed" | "unchanged" | "none" | "failed"
  > {
    const who = await installIdentity(database);
    if (!who) return "none";
    const row = await load();
    const license = row?.kind === "license" ? row : undefined;
    const url = license?.renewUrl ?? licenseUrl;
    const wasPaid = (await current()).state === "paid";
    fetching.lastAttemptAt = now();
    let error: string | null = null;
    let outcome: "activated" | "renewed" | "unchanged" = "unchanged";
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: who.customerId,
          installId: who.installId,
          version: options.version,
          ...(license ? { nonce: license.nonce } : {}),
          // No key yet: the start of time, so today's renew/ (which needs a date) answers too.
          validUntil: (license?.validUntil ?? new Date(0)).toISOString(),
          proof: who.proof,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        error = `The renewal was refused (${response.status}).`;
      } else {
        const body = (await response.json().catch(() => ({}))) as {
          key?: unknown;
        };
        if (typeof body.key === "string" && body.key.trim()) {
          const read = readActivationCode(body.key);
          if (read.code.action !== "license") {
            error = "The renewal did not send a licence key.";
          } else if (
            await activate(read.payload, read.signature, read.code, true)
          ) {
            outcome = wasPaid ? "renewed" : "activated";
          }
        }
      }
    } catch (caught) {
      error =
        caught instanceof TrialRefusedError
          ? caught.message
          : caught instanceof TrialFormatError
            ? "The renewal did not send a licence key."
            : "The renewal address could not be reached.";
    }
    fetching.lastError = error;
    if (!error) fetching.lastSuccessAt = now();
    if (outcome === "activated") fetching.paymentReceivedAt = now();
    if (license) {
      await database
        .update(activationState)
        .set(
          error
            ? { lastRenewError: error }
            : { lastRenewAt: now(), lastRenewError: null },
        )
        .where(eq(activationState.id, license.id));
    } else if (outcome === "activated") {
      await database
        .update(activationState)
        .set({ lastRenewAt: now(), lastRenewError: null })
        .where(eq(activationState.id, "install"));
    }
    return error ? "failed" : outcome;
  }

  return {
    current,

    /** The trial setup file's view, passed through for the account summary. */
    trialCurrent: () => trial.current(),

    /**
     * Takes anything typed into the one box: a trial activation code, a licence key, or one of the
     * unlock codes (extend, end, paid) that change a trial setup file's trial.
     */
    async apply(typed: string): Promise<AppliedCode> {
      const action = codeAction(typed);
      if (action === "trial" || action === "license") {
        let read: ReturnType<typeof readActivationCode>;
        try {
          read = readActivationCode(typed);
        } catch {
          throw new TrialRefusedError(
            "This is not an activation code or a licence key. Check that it was copied whole.",
          );
        }
        const changed = await activate(read.payload, read.signature, read.code);
        return { kind: read.code.action, changed, activation: await current() };
      }
      if (action === null) {
        throw new TrialRefusedError(
          "This is not an activation code or a licence key. Check that it was copied whole.",
        );
      }
      const { action: applied } = await trial.applyCode(typed);
      return { kind: applied, changed: true, activation: await current() };
    },

    /** What the account may do, with activation, the licence and the trial all having their say. */
    async entitlement(base: Entitlement): Promise<Entitlement> {
      const { view } = await resolve();
      if (view.source === "trial-profile") {
        const fromTrial = await trial.entitlement(base);
        if (view.allowed || fromTrial.canRun === false) return fromTrial;
        return blocked(fromTrial, view);
      }
      if (view.state === "none") {
        return view.allowed ? base : blocked(base, view);
      }
      const plan = view.planId ? planById(view.planId) : undefined;
      const withPlan: Entitlement = {
        ...base,
        planId: view.planId ?? base.planId,
        planName: view.planName ?? base.planName,
        subscriptionStatus: view.state === "paid" ? "active" : "trialing",
        maxActiveBots: plan ? plan.maxActiveBots : base.maxActiveBots,
      };
      if (!base.canRun) return withPlan;
      if (view.state === "paid" || view.state === "trial") return withPlan;
      return blocked(withPlan, view);
    },

    /** A paid licence lifts the trial's block on new employees; otherwise the trial decides. */
    async createBlocked(): Promise<boolean> {
      const view = await current();
      if (view.source === "license" && view.state === "paid") return false;
      return trial.createBlocked();
    },

    async refuseCreate(): Promise<void> {
      const view = await current();
      if (view.source === "license" && view.state === "paid") return;
      await trial.refuseCreate();
    },

    onRoster: (agentId: string) => trial.onRoster(agentId),

    /**
     * Whether a profile employee's role and standing instruction are read-only here (#116). A paid
     * licence lifts it, as it lifts the block on new employees; otherwise the trial decides.
     */
    async instructionsLocked(agentId: string): Promise<boolean> {
      const view = await current();
      if (view.source === "license" && view.state === "paid") return false;
      return trial.instructionsLocked(agentId);
    },

    async lockedEmployees(): Promise<{ key: string; agentId: string }[]> {
      const view = await current();
      if (view.source === "license" && view.state === "paid") return [];
      return trial.lockedEmployees();
    },

    /** An add-on is on when the active code or key carries it, or the trial setup file does. */
    async addonEnabled(name: TrialAddon): Promise<boolean> {
      const view = await current();
      if (
        (view.state === "paid" || view.state === "trial") &&
        view.addons.includes(name)
      ) {
        return true;
      }
      return trial.addonEnabled(name);
    },

    fetchKey,
    /** The v0.1.44 name: a renewal is the same request. */
    renew: fetchKey,

    /**
     * The person opened the buy page from the app (v0.1.49): ask every 20 seconds for the next 30
     * minutes, so the key arrives moments after Stripe says paid. Returns the page to open.
     */
    /**
     * The self-serve trial (v0.1.58; Amgad, 26 Nov 2026): blackark.uk emails a 6-digit code to the
     * address given. Only on a computer that is not activated and has no trial yet.
     */
    async startTrial(input: {
      name: string;
      company: string;
      email: string;
      language: "el" | "en";
    }): Promise<void> {
      if ((await current()).state !== "none")
        throw new TrialRefusedError(
          "This computer already has a trial or a licence.",
        );
      const email = input.email.trim().toLowerCase();
      const installId =
        selfServePending?.email === email &&
        now().getTime() - selfServePending.at < 15 * MINUTE
          ? selfServePending.installId
          : randomUUID();
      const answer = await askTrial({
        action: "start",
        name: input.name,
        company: input.company,
        email,
        installId,
        language: input.language,
      });
      if (answer.status !== 202)
        throw new TrialRefusedError(
          answer.error ?? "The trial could not be started. Try again shortly.",
        );
      selfServePending = { email, installId, at: now().getTime() };
    },

    /** The emailed code: blackark.uk signs the trial, and it is applied here at once. */
    async confirmTrial(input: {
      email: string;
      code: string;
    }): Promise<AppliedCode> {
      const email = input.email.trim().toLowerCase();
      if (!selfServePending || selfServePending.email !== email)
        throw new TrialRefusedError(
          "Ask for a code first: write your name, company and email.",
        );
      const answer = await askTrial({
        action: "confirm",
        email,
        installId: selfServePending.installId,
        code: input.code,
      });
      if (answer.status !== 200 || typeof answer.code !== "string")
        throw new TrialRefusedError(
          answer.error ?? "The code could not be checked. Try again shortly.",
        );
      const read = readActivationCode(answer.code);
      if (read.code.action !== "trial")
        throw new TrialRefusedError("BlackArk did not send a trial code.");
      const changed = await activate(read.payload, read.signature, read.code);
      selfServePending = null;
      return { kind: "trial", changed, activation: await current() };
    },

    async expectPayment(): Promise<{ buyUrl: string | null }> {
      fetching.fastUntil = new Date(now().getTime() + FAST_FOR);
      const view = await current();
      if (!view.buyUrl || !view.customerId) return { buyUrl: view.buyUrl };
      return {
        buyUrl:
          (await signedBuyUrl(view.customerId, view.buyUrl)) ?? view.buyUrl,
      };
    },

    /**
     * Asks for the key when `keyFetchDue` says so: on start-up, every few minutes while on a trial
     * or waiting on Activate, every 20 seconds after the buy page opens, daily once paid. Returns the
     * stop function.
     */
    startKeyFetch(): () => void {
      let stopped = false;
      let running = false;
      const tick = async () => {
        if (stopped || running) return;
        running = true;
        try {
          const row = await load();
          const license = row?.kind === "license" ? row : undefined;
          const paid = (await current()).state === "paid";
          const due = keyFetchDue({
            paid,
            lastAttemptAt: fetching.lastAttemptAt,
            lastRenewAt: license?.lastRenewAt ?? null,
            failed: license
              ? license.lastRenewError !== null
              : fetching.lastError !== null,
            fastUntil: fetching.fastUntil,
            now: now(),
          });
          if (due) await fetchKey();
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "license-fetch-failed",
              error: String(error),
            }),
          );
        } finally {
          running = false;
        }
      };
      const every = setInterval(tick, options.tickMs ?? FAST_EVERY);
      every.unref?.();
      // Soon after start, not at once: the server is still opening everything else.
      const first = setTimeout(tick, options.tickMs ?? 5_000);
      first.unref?.();
      return () => {
        stopped = true;
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
}
