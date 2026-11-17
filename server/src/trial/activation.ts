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
 * RENEWAL. A licence key may name `renewUrl`. Once a day this install sends that address the
 * customer id, this install's random id, the version and the key's nonce, and takes back a renewed
 * key if the answer carries one. Nothing else: no conversation, name or file.
 */
import type { KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type ActivationCode,
  codeAction,
  readActivationCode,
} from "../../../shared/activation";
import { planById } from "../../../shared/plans";
import { type TrialAddon, TrialFormatError } from "../../../shared/trial";
import { signedByAny } from "../../../shared/trial-sign";
import type { Entitlement } from "../accounts/store";
import type { Database } from "../db/client";
import { activationState } from "../db/schema";
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
  addons: TrialAddon[];
  /** The renewal host only. */
  renewHost: string | null;
  lastRenewAt: string | null;
  lastRenewError: string | null;
  /** Whether this build can check each kind of signature at all. */
  keys: { trial: boolean; license: boolean };
};

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

export type ActivationService = ReturnType<typeof createActivationService>;

export function createActivationService(
  database: Database,
  options: {
    required: boolean;
    trialKeys: readonly KeyObject[];
    licenseKeys: readonly KeyObject[];
    trial: TrialService;
    version: string;
    now?: () => Date;
    fetch?: typeof fetch;
  },
) {
  const { trial } = options;
  const now = options.now ?? (() => new Date());
  const send = options.fetch ?? fetch;

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
      addons: [] as TrialAddon[],
      renewHost,
      lastRenewAt: row?.lastRenewAt?.toISOString() ?? null,
      lastRenewError: row?.lastRenewError ?? null,
      keys: {
        trial: options.trialKeys.length > 0,
        license: options.licenseKeys.length > 0,
      },
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
    return { view, row, profile };
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
    checkSigned(
      isLicense ? options.licenseKeys : options.trialKeys,
      payload,
      signature,
      what,
    );
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
      if (
        row.kind === code.action &&
        row.validUntil.getTime() >= until.getTime()
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

  /** Asks the licence's renewal address for a renewed key, and takes it if it is one. */
  async function renew(): Promise<"renewed" | "unchanged" | "none" | "failed"> {
    const row = await load();
    if (row?.kind !== "license" || !row.renewUrl) return "none";
    let error: string | null = null;
    let outcome: "renewed" | "unchanged" = "unchanged";
    try {
      const response = await send(row.renewUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: row.customerId,
          installId: row.installId,
          version: options.version,
          nonce: row.nonce,
          validUntil: row.validUntil.toISOString(),
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
            outcome = "renewed";
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
    await database
      .update(activationState)
      .set(
        error
          ? { lastRenewError: error }
          : { lastRenewAt: now(), lastRenewError: null },
      )
      .where(eq(activationState.id, row.id));
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

    renew,

    /** At start and then once a day; hourly after a failure. Returns the stop function. */
    startRenewals(): () => void {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const row = await load();
          if (row?.kind !== "license" || !row.renewUrl) return;
          const last = row.lastRenewAt?.getTime() ?? 0;
          if (
            now().getTime() - last >= DAY - 5 * MINUTE ||
            row.lastRenewError
          ) {
            await renew();
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "license-renewal-failed",
              error: String(error),
            }),
          );
        }
      };
      const first = setTimeout(tick, 45_000);
      const every = setInterval(tick, 60 * MINUTE);
      first.unref?.();
      every.unref?.();
      return () => {
        stopped = true;
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
}
