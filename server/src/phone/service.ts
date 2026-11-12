import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ApprovalRecord, ApprovalStore } from "../approvals/store";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { phoneApprovalSettings } from "../db/schema";
import { type CallOutcome, type CallState, answered, pressed } from "./keypad";
import type { PhoneProvider } from "./provider";

/**
 * Approving by phone (P2 idea 10, desk #90), behind a provider (`provider.ts`) and off by default.
 *
 * NEVER BY PHONE, whatever any setting says: a browser or computer action (device control), and
 * anything that moves money. Checked here, on the server, before a call is placed, and the
 * keypad's answer is only ever applied to a request that passed it.
 */

/** Requests that a phone can never decide (Amgad's rule, desk #90). */
const DEVICE_CONTROL_KINDS = new Set(["computer.action"]);
const PAYMENT_WORDS =
  /\b(pay|pays|paid|payment|payout|charge|refund|transfer|purchase|checkout|invoice|wire|subscription|πληρωμ|επιστροφή χρημάτων|μεταφορά)\w*/i;
const PAYMENT_SERVERS = /stripe|paypal|wise|revolut|square|adyen|braintree/i;
const MONEY = /[€$£]\s?\d|\d\s?(€|eur|usd|gbp)\b/i;

export type PhoneRefusal =
  | "device-control"
  | "payment"
  | "kind"
  | "not-pending"
  | "off-for-employee"
  | "no-settings";

/** Whether a phone may ever decide this request, by what it is. */
export function phoneMayDecide(record: ApprovalRecord): PhoneRefusal | null {
  if (DEVICE_CONTROL_KINDS.has(record.kind)) return "device-control";
  if (record.kind !== "tool.call" && record.kind !== "chat.card") {
    return "kind";
  }
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const words = [
    record.summary,
    typeof payload.tool === "string" ? payload.tool : "",
    typeof payload.title === "string" ? payload.title : "",
    typeof payload.summary === "string" ? payload.summary : "",
    JSON.stringify(payload.details ?? ""),
    JSON.stringify(payload.args ?? ""),
  ].join(" ");
  const server = typeof payload.server === "string" ? payload.server : "";
  if (
    PAYMENT_WORDS.test(words) ||
    PAYMENT_SERVERS.test(server) ||
    MONEY.test(words)
  ) {
    return "payment";
  }
  return null;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function pinMatches(stored: string, pin: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(pin, Buffer.from(salt, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A phone number as the provider needs it: + and 8 to 15 digits. */
export function e164(raw: string): string | null {
  const compact = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

export type ActiveCall = {
  id: string;
  userId: string;
  approvalId: string;
  summary: string;
  state: CallState;
  /** What the call said last. */
  said: string;
  startedAt: Date;
};

export type PhoneSettingsView = {
  phone: string | null;
  hasPin: boolean;
  agentIds: string[];
};

export class PhoneSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneSettingsError";
  }
}

/** How long a call may ring before it counts as unanswered. */
export const RING_FOR_MS = 60_000;

export function createPhoneApprovals(options: {
  database: Database;
  approvals: ApprovalStore;
  audit: AuditStore;
  provider: PhoneProvider;
  now?: () => Date;
}) {
  const { database, approvals, audit, provider } = options;
  const now = options.now ?? (() => new Date());
  const calls = new Map<string, ActiveCall>();

  async function settingsRow(userId: string) {
    const [row] = await database
      .select()
      .from(phoneApprovalSettings)
      .where(eq(phoneApprovalSettings.userId, userId))
      .limit(1);
    return row ?? null;
  }

  async function finish(call: ActiveCall, outcome: CallOutcome) {
    calls.delete(call.id);
    await recordAuditEvent(audit, {
      eventType: "phone.call_ended",
      targetType: "approval",
      targetId: call.approvalId,
      actorUserId: call.userId,
      payload: { call: call.id, provider: provider.name, outcome },
    });
  }

  /** Calls that rang too long without an answer end as unanswered. */
  async function expire() {
    const at = now().getTime();
    for (const call of [...calls.values()]) {
      if (
        call.state.step === "ringing" &&
        at - call.startedAt.getTime() > RING_FOR_MS
      ) {
        await finish(call, "no-answer");
      }
    }
  }

  return {
    providerName: provider.name,

    async settings(userId: string): Promise<PhoneSettingsView> {
      const row = await settingsRow(userId);
      return {
        phone: row?.phone ?? null,
        hasPin: Boolean(row?.pinHash),
        agentIds: row?.agentIds ?? [],
      };
    },

    async saveSettings(
      userId: string,
      input: { phone: string; pin?: string; agentIds: string[] },
    ): Promise<PhoneSettingsView> {
      const phone = e164(input.phone);
      if (!phone) {
        throw new PhoneSettingsError(
          "Give the number with its country code, for example +30 69 1234 5678.",
        );
      }
      const existing = await settingsRow(userId);
      if (input.pin !== undefined && !/^\d{4,8}$/.test(input.pin)) {
        throw new PhoneSettingsError("A PIN is 4 to 8 digits.");
      }
      const pinHash = input.pin ? hashPin(input.pin) : existing?.pinHash;
      if (!pinHash) {
        throw new PhoneSettingsError("Choose a PIN of 4 to 8 digits.");
      }
      const agentIds = [...new Set(input.agentIds)].slice(0, 50);
      await database
        .insert(phoneApprovalSettings)
        .values({ userId, phone, pinHash, agentIds })
        .onConflictDoUpdate({
          target: phoneApprovalSettings.userId,
          set: { phone, pinHash, agentIds, updatedAt: now() },
        });
      await recordAuditEvent(audit, {
        eventType: "phone.settings_changed",
        targetType: "user",
        targetId: userId,
        actorUserId: userId,
        // Never the PIN, and never the number: only that they changed.
        payload: { pinChanged: Boolean(input.pin), employees: agentIds.length },
      });
      return { phone, hasPin: true, agentIds };
    },

    /**
     * Ring the owner about a request, when the request may be decided by phone and the employee
     * that asked is one they chose. Returns why not, or the call.
     */
    async callAbout(
      ownerUserId: string,
      approvalId: string,
    ): Promise<{ call: ActiveCall } | { refused: PhoneRefusal }> {
      await expire();
      const record = await approvals.get(ownerUserId, approvalId);
      if (record?.status !== "pending") {
        return { refused: "not-pending" };
      }
      const rule = phoneMayDecide(record);
      if (rule) return { refused: rule };
      const settings = await settingsRow(ownerUserId);
      if (!settings) return { refused: "no-settings" };
      if (!settings.agentIds.includes(record.requestedByAgentId)) {
        return { refused: "off-for-employee" };
      }
      const call: ActiveCall = {
        id: `call_${crypto.randomUUID()}`,
        userId: ownerUserId,
        approvalId,
        summary: record.summary,
        state: { step: "ringing" },
        said: "",
        startedAt: now(),
      };
      calls.set(call.id, call);
      await provider.place({
        id: call.id,
        userId: ownerUserId,
        to: settings.phone,
      });
      await recordAuditEvent(audit, {
        eventType: "phone.call_placed",
        targetType: "approval",
        targetId: approvalId,
        actorUserId: ownerUserId,
        payload: { call: call.id, provider: provider.name },
      });
      return { call };
    },

    /** The person's calls still going, for the simulated phone. */
    async active(userId: string): Promise<ActiveCall[]> {
      await expire();
      return [...calls.values()].filter((call) => call.userId === userId);
    },

    async answer(userId: string, callId: string): Promise<ActiveCall | null> {
      const call = calls.get(callId);
      if (!call || call.userId !== userId || call.state.step !== "ringing") {
        return null;
      }
      const next = answered();
      call.state = next.state;
      call.said = next.say;
      await recordAuditEvent(audit, {
        eventType: "phone.call_answered",
        targetType: "approval",
        targetId: call.approvalId,
        actorUserId: userId,
        payload: { call: call.id, provider: provider.name },
      });
      return call;
    },

    async hangUp(userId: string, callId: string): Promise<void> {
      const call = calls.get(callId);
      if (!call || call.userId !== userId) return;
      // A call hung up before it was answered was not answered: either way, nothing is decided.
      await finish(
        call,
        call.state.step === "ringing" ? "no-answer" : "hung-up",
      );
    },

    /**
     * Keys pressed on the call. Approve and decline go through the same decision the app's
     * buttons make, as the owner, so the request is carried out and audited exactly as from
     * Requests; and only for a request that passed `phoneMayDecide` when the call was placed.
     */
    async press(
      userId: string,
      callId: string,
      keys: string,
    ): Promise<ActiveCall | null> {
      const call = calls.get(callId);
      if (!call || call.userId !== userId) return null;
      const settings = await settingsRow(userId);
      const next = pressed(call.state, keys, call.summary, (pin) =>
        settings ? pinMatches(settings.pinHash, pin) : false,
      );
      call.state = next.state;
      call.said = next.say;
      if (next.state.step === "ended") {
        const outcome = next.state.outcome;
        if (outcome === "approved" || outcome === "declined") {
          try {
            await approvals.decide(
              userId,
              call.approvalId,
              outcome === "approved" ? "approve" : "reject",
            );
          } catch (error) {
            call.said =
              error instanceof Error
                ? `${error.message} Goodbye.`
                : "That request could not be decided. Goodbye.";
          }
        }
        await finish(call, outcome);
      }
      return call;
    },
  };
}

export type PhoneApprovals = ReturnType<typeof createPhoneApprovals>;
