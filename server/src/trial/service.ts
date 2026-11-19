/**
 * A customer trial on this install (#109, v0.1.37): the signed profile, the day the trial ends, the
 * block on making more digital employees, unlock codes, and the daily check-in.
 *
 * ONE TRIAL PER INSTALL. A desktop install is one person on one computer, so the trial belongs to
 * the install, not to an account: there is one `trial_state` row or none. No row, and nothing here
 * changes anything; every function answers "no trial".
 *
 * WHAT CAN MOVE THE END. Only a signed profile (a newer one for the same customer) or a signed unlock
 * code. The computer's clock cannot: the end is compared with the later of the clock and the latest
 * time this install has seen, so turning the clock back leaves the trial where it was.
 *
 * WHAT A CHECK-IN SAYS. The customer id from the profile, this install's random id, the version, the
 * trial status, days left, the end, and how many employees the roster has. From v0.1.49 (#149) also
 * counts: people, people active in 7 days, conversations started in 7 days, whether a phone line is
 * set up, and the kind of system (counts.ts). Never a conversation, a name, a file or anything else
 * a person wrote.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { KeyObject } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { planById } from "../../../shared/plans";
import {
  readProfileFile,
  readUnlockCode,
  type TrialAddon,
  TrialFormatError,
  type TrialProfile,
  trialDaysLeftAt,
  trialLengthDays,
} from "../../../shared/trial";
import { publicKeyFromBase64, signedByAny } from "../../../shared/trial-sign";
import type { Entitlement } from "../accounts/store";
import type { Database } from "../db/client";
import { trialCodes, trialRoster, trialState } from "../db/schema";
import type { CheckInCounts } from "./counts";

/** Said when a create is refused during a trial. The app shows it, in Greek when chosen. */
export const CREATE_BLOCKED_MESSAGE =
  "During the trial you cannot create extra digital employees. The trial employees are already set up.";

export class TrialCreateBlockedError extends Error {
  constructor() {
    super(CREATE_BLOCKED_MESSAGE);
    this.name = "TrialCreateBlockedError";
  }
}

/**
 * Said when a change to a profile employee's role or standing instruction is refused during a trial
 * (#116). The app shows it, in Greek when chosen, and offers "Propose a change" next to it.
 */
export const INSTRUCTIONS_LOCKED_MESSAGE =
  "This digital employee's role and standing instruction come from BlackArk's signed trial profile, so they cannot be changed on this computer. Use Propose a change to send BlackArk the new text.";

export class TrialInstructionsLockedError extends Error {
  constructor() {
    super(INSTRUCTIONS_LOCKED_MESSAGE);
    this.name = "TrialInstructionsLockedError";
  }
}

/** A profile or code that was refused, in words the person is shown. */
export class TrialRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrialRefusedError";
  }
}

export type TrialView = {
  customerId: string;
  customerName: string;
  /** "trial" while it runs, "ended" from the last moment on, "paid" once converted. */
  status: "trial" | "ended" | "paid";
  startsAt: string;
  endsAt: string;
  lengthDays: number;
  daysLeft: number;
  planId: string;
  planName: string;
  /** Whether making more employees is refused right now. Never while paid. */
  createBlocked: boolean;
  rosterSize: number;
  /** The check-in host only: enough to say where, nothing that looks like a secret. */
  checkInHost: string | null;
  lastCheckInAt: string | null;
  lastCheckInError: string | null;
};

type Row = typeof trialState.$inferSelect;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** The keys this build trusts: the built-in ones, and the variable where a server is allowed one. */
export function trialKeysFrom(
  builtIn: readonly string[],
  variable: string | undefined,
): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const encoded of [...builtIn, ...(variable?.split(",") ?? [])]) {
    if (!encoded.trim()) continue;
    try {
      keys.push(publicKeyFromBase64(encoded));
    } catch {
      console.error(
        JSON.stringify({
          type: "trial-key-unreadable",
          length: encoded.length,
        }),
      );
    }
  }
  return keys;
}

export type TrialSeeder = (entry: TrialProfile["roster"][number]) => Promise<{
  agentId: string;
}>;

export type TrialService = ReturnType<typeof createTrialService>;

export function createTrialService(
  database: Database,
  options: {
    keys: readonly KeyObject[];
    version: string;
    now?: () => Date;
    fetch?: typeof fetch;
    /** The counts a check-in carries (counts.ts). Absent, or failing: the check-in goes without. */
    counts?: () => Promise<CheckInCounts>;
  },
) {
  const now = options.now ?? (() => new Date());
  const send = options.fetch ?? fetch;
  /** Set while the roster itself is being created, so the block does not refuse its own seeding. */
  const seeding = new AsyncLocalStorage<boolean>();
  let seedRun: Promise<number> | null = null;

  async function load(): Promise<Row | undefined> {
    const [row] = await database.select().from(trialState).limit(1);
    return row;
  }

  /** The later of the clock and what this install has seen, remembered as it moves forward. */
  async function seenNow(row: Row): Promise<Date> {
    const clock = now();
    if (clock.getTime() > row.latestSeenAt.getTime() + MINUTE) {
      await database
        .update(trialState)
        .set({ latestSeenAt: clock })
        .where(eq(trialState.id, row.id));
      return clock;
    }
    return clock.getTime() > row.latestSeenAt.getTime()
      ? clock
      : row.latestSeenAt;
  }

  function endOf(row: Row): Date {
    return row.endsOverrideAt ?? row.endsAt;
  }

  async function view(row: Row): Promise<TrialView> {
    const at = await seenNow(row);
    const end = endOf(row);
    const status: TrialView["status"] =
      row.status === "paid"
        ? "paid"
        : at.getTime() >= end.getTime()
          ? "ended"
          : "trial";
    const profile = readProfileFile(
      JSON.stringify({
        format: "arktrial/1",
        profile: row.profile,
        signature: row.signature,
      }),
    ).profile;
    let checkInHost: string | null = null;
    try {
      checkInHost = row.checkInUrl ? new URL(row.checkInUrl).host : null;
    } catch {
      checkInHost = null;
    }
    return {
      customerId: row.customerId,
      customerName: row.customerName,
      status,
      startsAt: row.startsAt.toISOString(),
      endsAt: end.toISOString(),
      lengthDays: trialLengthDays(
        row.startsAt.toISOString(),
        end.toISOString(),
      ),
      daysLeft: status === "paid" ? 0 : trialDaysLeftAt(end.toISOString(), at),
      planId: row.planId,
      planName: planById(row.planId)?.name ?? row.planId,
      createBlocked: status !== "paid" && row.createBlocked,
      rosterSize: profile.roster.length,
      checkInHost,
      lastCheckInAt: row.lastCheckInAt?.toISOString() ?? null,
      lastCheckInError: row.lastCheckInError,
    };
  }

  function checkSigned(text: string, signature: string, what: string) {
    if (options.keys.length === 0) {
      throw new TrialRefusedError(
        "This version of ArkAgent has no BlackArk key yet, so it cannot check a trial profile or code. Ask BlackArk for the current version.",
      );
    }
    if (!signedByAny(options.keys, text, signature)) {
      throw new TrialRefusedError(`This ${what} is not signed by BlackArk.`);
    }
  }

  async function current(): Promise<TrialView | null> {
    const row = await load();
    return row ? view(row) : null;
  }

  /** Whether the person is refused a new employee right now. False during seeding. */
  async function createBlocked(): Promise<boolean> {
    if (seeding.getStore()) return false;
    const trial = await current();
    return trial?.createBlocked ?? false;
  }

  /** The roster in the stored profile, for seeding. */
  async function roster(): Promise<TrialProfile["roster"]> {
    const row = await load();
    if (!row) return [];
    return readProfileFile(
      JSON.stringify({
        format: "arktrial/1",
        profile: row.profile,
        signature: row.signature,
      }),
    ).profile.roster;
  }

  /** Whether this employee is one of the roster's. */
  async function onRoster(agentId: string): Promise<boolean> {
    const [row] = await database
      .select({ key: trialRoster.key })
      .from(trialRoster)
      .where(eq(trialRoster.agentId, agentId))
      .limit(1);
    return Boolean(row);
  }

  /** The roster's agent ids, in roster order, for the employees set up so far. */
  async function rosterAgents(): Promise<{ key: string; agentId: string }[]> {
    return database
      .select({ key: trialRoster.key, agentId: trialRoster.agentId })
      .from(trialRoster);
  }

  /**
   * Whether the signed profile owns the role and standing instruction of the roster's employees now
   * (#116): from import until the trial is converted to paid, an ended trial included. Never while
   * the roster is being set up or a newer profile's text is being applied.
   */
  async function instructionsLocked(): Promise<boolean> {
    if (seeding.getStore()) return false;
    const row = await load();
    return row !== undefined && row.status !== "paid";
  }

  /** Reports status and days left to the profile's check-in address, if it names one. */
  async function checkIn(): Promise<"sent" | "none" | "failed"> {
    const row = await load();
    if (!row?.checkInUrl) return "none";
    const trial = await view(row);
    let counts: CheckInCounts | Record<string, never> = {};
    try {
      counts = (await options.counts?.()) ?? {};
    } catch {
      counts = {};
    }
    const body = {
      ...counts,
      customerId: row.customerId,
      installId: row.installId,
      version: options.version,
      status: trial.status,
      daysLeft: trial.daysLeft,
      endsAt: trial.endsAt,
      employees: trial.rosterSize,
      /*
       * The signed profile itself, so a receiver can check with BlackArk's public key that this
       * check-in comes from a real trial for this customer (the one.com receiver does). Nothing in
       * it was written by the customer: it is the file BlackArk signed.
       */
      proof: { profile: row.profile, signature: row.signature },
    };
    let error: string | null = null;
    try {
      const response = await send(row.checkInUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        error = `The check-in was refused (${response.status}).`;
    } catch {
      error = "The check-in address could not be reached.";
    }
    await database
      .update(trialState)
      .set(
        error
          ? { lastCheckInError: error }
          : { lastCheckInAt: now(), lastCheckInError: null },
      )
      .where(eq(trialState.id, row.id));
    return error ? "failed" : "sent";
  }

  return {
    /** The trial on this install, or null when there is none. */
    current,

    createBlocked,

    /** Refuses with the sentence the app shows, when making employees is blocked. */
    async refuseCreate(): Promise<void> {
      if (await createBlocked()) throw new TrialCreateBlockedError();
    },

    /**
     * Whether BlackArk switched a paid add-on on for this customer, in the signed profile (#109).
     * No trial profile, or a profile without it: off.
     */
    async addonEnabled(name: TrialAddon): Promise<boolean> {
      const row = await load();
      if (!row) return false;
      const profile = readProfileFile(
        JSON.stringify({
          format: "arktrial/1",
          profile: row.profile,
          signature: row.signature,
        }),
      ).profile;
      return profile.addons?.includes(name) === true;
    },

    /**
     * The mailbox rules for one employee, from the profile (#109): its folders and From address,
     * and the AMKA block for the whole install. Empty when there is no trial.
     */
    async mailPolicyFor(agentId: string | undefined): Promise<{
      folders?: string[];
      from?: string;
      blockAmka?: boolean;
    }> {
      const row = await load();
      if (!row) return {};
      const profile = readProfileFile(
        JSON.stringify({
          format: "arktrial/1",
          profile: row.profile,
          signature: row.signature,
        }),
      ).profile;
      const blockAmka = profile.mailBlockAmka === true;
      if (!agentId) return blockAmka ? { blockAmka } : {};
      const [seeded] = await database
        .select({ key: trialRoster.key })
        .from(trialRoster)
        .where(eq(trialRoster.agentId, agentId))
        .limit(1);
      const mail = seeded
        ? profile.roster.find((entry) => entry.key === seeded.key)?.mail
        : undefined;
      return {
        ...(mail?.folders ? { folders: mail.folders } : {}),
        ...(mail?.from ? { from: mail.from } : {}),
        ...(blockAmka ? { blockAmka } : {}),
      };
    },

    onRoster,

    /**
     * Whether this employee's role and standing instruction may not be changed here (#116): it is one
     * of the signed profile's, and the profile still owns them. An employee the customer made is
     * never locked, and nothing is without a trial profile.
     */
    async instructionsLocked(agentId: string): Promise<boolean> {
      return (await instructionsLocked()) && (await onRoster(agentId));
    },

    /** The profile's employees whose instruction is locked now, with their profile key (#116). */
    async lockedEmployees(): Promise<{ key: string; agentId: string }[]> {
      return (await instructionsLocked()) ? rosterAgents() : [];
    },

    /**
     * Runs `apply` as the profile itself (#116), so the lock does not refuse it: for writing a newer
     * signed profile's text onto the employees it already set up.
     */
    asProfile<T>(apply: () => Promise<T>): Promise<T> {
      return seeding.run(true, apply);
    },

    /**
     * What the account may do, once the trial has had its say. No trial or a paid one: unchanged.
     * Otherwise the plan is the profile's, and from the last moment on, nothing runs.
     */
    async entitlement(base: Entitlement): Promise<Entitlement> {
      const trial = await current();
      if (!trial || trial.status === "paid") return base;
      const plan = planById(trial.planId);
      const withPlan: Entitlement = {
        ...base,
        planId: trial.planId,
        planName: trial.planName,
        subscriptionStatus: "trialing",
        maxActiveBots: plan ? plan.maxActiveBots : base.maxActiveBots,
      };
      if (!base.canRun) return withPlan;
      if (trial.status === "ended") {
        return {
          ...withPlan,
          canRun: false,
          blockedCode: "trial_ended",
          blockedReason: `Your ${trial.lengthDays}-day trial ended on ${trial.endsAt.slice(0, 10)}. Your conversations and settings are kept. Enter an unlock code in Settings, then Plan, to continue.`,
        };
      }
      return withPlan;
    },

    /**
     * Takes a profile file's text. Checked, then stored: the first one, or a newer one for the same
     * customer. The same one again changes nothing, so importing the file twice is harmless.
     */
    async importProfile(fileText: string): Promise<{
      trial: TrialView;
      changed: boolean;
    }> {
      let read: ReturnType<typeof readProfileFile>;
      try {
        read = readProfileFile(fileText);
      } catch (error) {
        throw new TrialRefusedError(
          error instanceof TrialFormatError
            ? error.message
            : "This file is not a trial profile.",
        );
      }
      checkSigned(read.file.profile, read.file.signature, "trial profile");
      const profile = read.profile;
      const existing = await load();
      if (existing && existing.customerId !== profile.customer.id) {
        throw new TrialRefusedError(
          `This computer already has the trial for ${existing.customerName}. A profile for another customer cannot replace it.`,
        );
      }
      const issuedAt = new Date(profile.issuedAt);
      if (existing && issuedAt.getTime() < existing.issuedAt.getTime()) {
        throw new TrialRefusedError(
          "This trial profile is older than the one already imported.",
        );
      }
      if (existing && issuedAt.getTime() === existing.issuedAt.getTime()) {
        return { trial: await view(existing), changed: false };
      }
      const values = {
        customerId: profile.customer.id,
        customerName: profile.customer.name,
        profile: read.file.profile,
        signature: read.file.signature,
        issuedAt,
        startsAt: new Date(profile.startsAt),
        endsAt: new Date(profile.endsAt),
        endsOverrideAt: null,
        planId: profile.plan,
        createBlocked: profile.createBlocked,
        checkInUrl: profile.checkInUrl ?? null,
        updatedAt: now(),
      };
      await database
        .insert(trialState)
        .values({ id: "install", ...values, latestSeenAt: now() })
        .onConflictDoUpdate({ target: trialState.id, set: values });
      const row = await load();
      if (!row) throw new Error("The trial was not stored.");
      return { trial: await view(row), changed: true };
    },

    roster,

    /**
     * Sets up each roster employee not set up before, once. One at a time, so two requests at the
     * same moment do not make two of anybody; an employee a person later deletes stays deleted.
     */
    seed(seeder: TrialSeeder): Promise<number> {
      const run = async () => {
        const entries = await roster();
        if (entries.length === 0) return 0;
        const done = new Set(
          (
            await database.select({ key: trialRoster.key }).from(trialRoster)
          ).map((row) => row.key),
        );
        let made = 0;
        for (const entry of entries) {
          if (done.has(entry.key)) continue;
          const { agentId } = await seeding.run(true, () => seeder(entry));
          await database
            .insert(trialRoster)
            .values({ key: entry.key, agentId })
            .onConflictDoNothing();
          made += 1;
        }
        return made;
      };
      /*
       * One at a time across processes too: a transaction holds an advisory lock while the roster
       * is set up, so a second replica waits and then finds every key already done. The employees
       * themselves are made on other connections, which never ask for this lock.
       */
      const locked = () =>
        database.transaction(async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtext('trial-roster-seed'))`,
          );
          return run();
        });
      const previous = seedRun ?? Promise.resolve(0);
      const next = previous.catch(() => 0).then(locked);
      seedRun = next;
      return next;
    },

    rosterAgents,

    /**
     * Applies an unlock code: a later end, an end now, or paid. Each code works once, and only for
     * the customer it was made for.
     */
    async applyCode(typed: string): Promise<{
      action: "extend" | "end" | "paid";
      trial: TrialView;
    }> {
      let read: ReturnType<typeof readUnlockCode>;
      try {
        read = readUnlockCode(typed);
      } catch {
        throw new TrialRefusedError(
          "This is not an unlock code. Check that it was copied whole.",
        );
      }
      checkSigned(read.payload, read.signature, "unlock code");
      const row = await load();
      if (!row) {
        throw new TrialRefusedError(
          "There is no trial on this computer to unlock.",
        );
      }
      const code = read.code;
      if (code.customer !== row.customerId) {
        throw new TrialRefusedError(
          "This unlock code is for another customer.",
        );
      }
      if (row.status === "paid") {
        throw new TrialRefusedError("This trial is already converted to paid.");
      }
      const at = await seenNow(row);
      await database.transaction(async (transaction) => {
        const [used] = await transaction
          .insert(trialCodes)
          .values({
            nonce: code.nonce,
            customerId: code.customer,
            action: code.action,
            until: code.until ? new Date(code.until) : null,
          })
          .onConflictDoNothing()
          .returning({ nonce: trialCodes.nonce });
        if (!used) {
          throw new TrialRefusedError("This unlock code was already used.");
        }
        const set: Partial<typeof trialState.$inferInsert> = {
          updatedAt: now(),
        };
        if (code.action === "extend" && code.until) {
          set.endsOverrideAt = new Date(code.until);
        } else if (code.action === "end") {
          set.endsOverrideAt = at;
        } else if (code.action === "paid") {
          set.status = "paid";
        }
        await transaction
          .update(trialState)
          .set(set)
          .where(eq(trialState.id, row.id));
      });
      const after = await load();
      if (!after) throw new Error("The trial disappeared.");
      return { action: code.action, trial: await view(after) };
    },

    checkIn,

    /**
     * At start and then once a day. Tries again hourly after a failure. Returns the stop function.
     */
    startCheckIns(): () => void {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const row = await load();
          if (!row?.checkInUrl) return;
          const last = row.lastCheckInAt?.getTime() ?? 0;
          if (
            now().getTime() - last >= DAY - 5 * MINUTE ||
            row.lastCheckInError
          ) {
            await checkIn();
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "trial-check-in-failed",
              error: String(error),
            }),
          );
        }
      };
      const first = setTimeout(tick, 30_000);
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

/** For tests and the admin screen: how many trial rows there are. */
export async function trialCount(database: Database): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(trialState);
  return row?.count ?? 0;
}
