/**
 * The business's own phone line on this install (#109).
 *
 * SET UP once by an administrator: BlackArk's relay address and the line token it issued, the speech
 * key the customer chose, which digital employee answers, its greeting, and the opening hours. Both
 * secrets go into the vault, encrypted; the row holds pointers.
 *
 * RUNNING. While a line is set up and switched on, this install keeps one outgoing WebSocket to the
 * relay and answers each call it is handed with {@link startCallBridge}. One process per database
 * holds the connection (a Postgres advisory lock), so a second process never answers the same call.
 *
 * KEPT. Per call: the time, the caller's number, how long it lasted, the outcome, a one-line summary
 * and any callback. No audio and no transcript.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptCredentialForUse,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import { type PhoneLineHours, phoneCalls, phoneLine } from "../db/schema";
import {
  type CallRecord,
  phoneRules,
  type SpeechConnect,
  startCallBridge,
} from "./bridge";

const LINE_ID = "line";
const LOCK_KEY = 7_109_000_001;

export type PhoneLineInput = {
  relayUrl: string;
  lineToken?: string;
  speechKey?: string;
  agentId: string;
  speechModel: string;
  voice: string;
  greeting: string;
  hours: PhoneLineHours | null;
  enabled: boolean;
};

export type PhoneLineView = {
  relayUrl: string;
  agentId: string;
  speechModel: string;
  voice: string;
  greeting: string;
  hours: PhoneLineHours | null;
  enabled: boolean;
  status: "connected" | "connecting" | "off" | "refused";
  /** A sentence for the settings page when the relay refused or could not be reached. */
  problem: string | null;
};

export type PhoneCallView = {
  id: string;
  fromNumber: string;
  startedAt: string;
  durationSeconds: number | null;
  outcome: string;
  summary: string;
  callback: {
    name: string;
    number: string;
    reason: string;
    done: boolean;
  } | null;
};

export class PhoneLineRefusedError extends Error {}

/** Whether `at` falls inside the opening hours, in Athens time. No hours: always open. */
export function isOpen(hours: PhoneLineHours | null, at = new Date()): boolean {
  if (!hours || Object.keys(hours).length === 0) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Athens",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    get("weekday"),
  );
  const now = `${get("hour")}:${get("minute")}`;
  const today = hours[String(day) as keyof PhoneLineHours];
  return Boolean(today && now >= today.from && now < today.to);
}

/** The relay's install socket, from its https address. */
export function lineSocketUrl(
  relayUrl: string,
  allowInsecure = false,
): string | null {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (allowInsecure && url.protocol === "http:") url.protocol = "ws:";
  else return null;
  if (url.username || url.password || url.search || url.hash) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/line`;
  return url.href;
}

type Employee = {
  name: string;
  title: string;
  instruction: string;
};

export function createPhoneLineService(
  database: Database,
  dependencies: {
    credentials: CredentialStore & CredentialSecretReader;
    encryptionKey: string;
    auditStore: AuditStore;
    /** The employee's name, title and standing instruction, read as the line's owner. */
    employee: (
      ownerUserId: string,
      agentId: string,
    ) => Promise<Employee | null>;
    /** The business's name, for the greeting rules: the trial's customer, or the deployment's. */
    business: () => Promise<string>;
    /** Whether Eurodiagnosi's AMKA rule applies (the trial profile's `mailBlockAmka`). */
    blockAmka: () => Promise<boolean>;
    connectSpeech?: SpeechConnect;
    /** Tests only: a relay on http://localhost. */
    allowInsecureRelay?: boolean;
    openSocket?: (url: string, token: string) => WebSocket;
  },
) {
  const { credentials, encryptionKey, auditStore } = dependencies;
  let status: PhoneLineView["status"] = "off";
  let problem: string | null = null;
  let socket: WebSocket | null = null;
  let stopped = true;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let releaseLock: (() => Promise<void>) | null = null;
  const bridges = new Map<string, ReturnType<typeof startCallBridge>>();

  const openSocket =
    dependencies.openSocket ??
    ((url: string, token: string) =>
      new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
      } as never));

  async function load() {
    const [row] = await database
      .select()
      .from(phoneLine)
      .where(eq(phoneLine.id, LINE_ID));
    return row ?? null;
  }

  async function secret(id: string): Promise<string> {
    return decryptCredentialForUse(encryptionKey, credentials, id);
  }

  async function storeSecret(
    keyId: "line-token" | "speech-key",
    value: string,
  ): Promise<string> {
    const key = { kind: "connector" as const, provider: "phone-line", keyId };
    const stored = {
      ...key,
      metadata: { purpose: keyId },
      encryptedValue: await encryptSecret(encryptionKey, value),
    };
    const live = await credentials.findLiveByKey(key);
    const saved = live
      ? await credentials.rotate({ ...stored, previousCredentialId: live.id })
      : await credentials.create(stored);
    return saved.id;
  }

  function view(row: Awaited<ReturnType<typeof load>>): PhoneLineView | null {
    if (!row) return null;
    return {
      relayUrl: row.relayUrl,
      agentId: row.agentId,
      speechModel: row.speechModel,
      voice: row.voice,
      greeting: row.greeting,
      hours: row.hours ?? null,
      enabled: row.enabled,
      status: row.enabled ? status : "off",
      problem: row.enabled ? problem : null,
    };
  }

  async function save(
    actorUserId: string,
    input: PhoneLineInput,
  ): Promise<PhoneLineView> {
    if (!lineSocketUrl(input.relayUrl, dependencies.allowInsecureRelay)) {
      throw new PhoneLineRefusedError(
        "The relay address must start with https://.",
      );
    }
    const employee = await dependencies.employee(actorUserId, input.agentId);
    if (!employee) {
      throw new PhoneLineRefusedError(
        "That digital employee is not one of yours.",
      );
    }
    const existing = await load();
    if (!existing && (!input.lineToken || !input.speechKey)) {
      throw new PhoneLineRefusedError(
        "Enter the line token and the speech key.",
      );
    }
    const lineCredentialId = input.lineToken
      ? await storeSecret("line-token", input.lineToken)
      : (existing?.lineCredentialId as string);
    const speechCredentialId = input.speechKey
      ? await storeSecret("speech-key", input.speechKey)
      : (existing?.speechCredentialId as string);
    const values = {
      id: LINE_ID,
      relayUrl: input.relayUrl,
      agentId: input.agentId,
      ownerUserId: actorUserId,
      lineCredentialId,
      speechCredentialId,
      speechModel: input.speechModel,
      voice: input.voice,
      greeting: input.greeting,
      hours: input.hours,
      enabled: input.enabled,
      updatedAt: new Date(),
    };
    await database
      .insert(phoneLine)
      .values(values)
      .onConflictDoUpdate({ target: phoneLine.id, set: values });
    await recordAuditEvent(auditStore, {
      eventType: "phone.line_saved",
      targetType: "phone_line",
      targetId: LINE_ID,
      actorUserId,
      payload: {
        agent: input.agentId,
        enabled: input.enabled,
        relay: new URL(input.relayUrl).host,
        lineTokenChanged: Boolean(input.lineToken),
        speechKeyChanged: Boolean(input.speechKey),
      },
    });
    restart();
    return view(await load()) as PhoneLineView;
  }

  async function remove(actorUserId: string): Promise<void> {
    const row = await load();
    if (!row) return;
    await database.delete(phoneLine).where(eq(phoneLine.id, LINE_ID));
    await credentials.revoke(row.lineCredentialId).catch(() => undefined);
    await credentials.revoke(row.speechCredentialId).catch(() => undefined);
    await recordAuditEvent(auditStore, {
      eventType: "phone.line_removed",
      targetType: "phone_line",
      targetId: LINE_ID,
      actorUserId,
      payload: {},
    });
    restart();
  }

  async function calls(limit = 50): Promise<PhoneCallView[]> {
    const rows = await database
      .select()
      .from(phoneCalls)
      .orderBy(desc(phoneCalls.startedAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((row) => ({
      id: row.id,
      fromNumber: row.fromNumber,
      startedAt: row.startedAt.toISOString(),
      durationSeconds: row.durationSeconds,
      outcome: row.outcome,
      summary: row.summary,
      callback: row.callbackReason
        ? {
            name: row.callbackName ?? "",
            number: row.callbackNumber ?? "",
            reason: row.callbackReason,
            done: row.callbackDoneAt !== null,
          }
        : null,
    }));
  }

  async function markCallbackDone(id: string): Promise<boolean> {
    const done = await database
      .update(phoneCalls)
      .set({ callbackDoneAt: new Date() })
      .where(and(eq(phoneCalls.id, id), isNull(phoneCalls.callbackDoneAt)))
      .returning({ id: phoneCalls.id });
    return done.length > 0;
  }

  // ---- answering ------------------------------------------------------------------------------

  const sendToRelay = (message: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };

  async function answer(callId: string, from: string) {
    const row = await load();
    const refuse = async (reason: string) => {
      sendToRelay({ type: "transfer", callId });
      await recordAuditEvent(auditStore, {
        eventType: "phone.line_refused",
        targetType: "phone_line",
        targetId: LINE_ID,
        initiator: { kind: "deployment" },
        payload: { call: callId, reason },
      });
    };
    if (!row?.enabled) return refuse("the line is switched off");
    const employee = await dependencies.employee(row.ownerUserId, row.agentId);
    if (!employee) return refuse("the answering employee is gone");
    let apiKey: string;
    try {
      apiKey = await secret(row.speechCredentialId);
    } catch {
      return refuse("the speech key is unusable");
    }
    const afterHours = !isOpen(row.hours ?? null);
    const blockAmka = await dependencies.blockAmka();
    await database
      .insert(phoneCalls)
      .values({ callId, agentId: row.agentId, fromNumber: from.slice(0, 32) })
      .onConflictDoNothing();
    await recordAuditEvent(auditStore, {
      eventType: "phone.call_answered",
      targetType: "phone_line",
      targetId: LINE_ID,
      initiator: { kind: "deployment" },
      payload: { call: callId, agent: row.agentId, afterHours },
    });
    const instructions = [
      phoneRules({
        business: await dependencies.business(),
        employee: employee.name,
        title: employee.title,
        afterHours,
        blockAmka,
      }),
      "",
      "Your standing instruction follows.",
      employee.instruction,
    ].join("\n");
    const bridge = startCallBridge({
      callId,
      from,
      model: row.speechModel,
      apiKey,
      voice: row.voice,
      instructions,
      greeting: row.greeting,
      blockAmka,
      afterHours,
      relay: sendToRelay,
      connect: dependencies.connectSpeech,
      onEnd: (record) => {
        bridges.delete(callId);
        void logEnd(callId, record);
      },
    });
    bridges.set(callId, bridge);
  }

  async function logEnd(callId: string, record: CallRecord) {
    await database
      .update(phoneCalls)
      .set({
        endedAt: new Date(),
        outcome: record.outcome,
        summary: record.summary.slice(0, 300),
        ...(record.callback
          ? {
              callbackName: record.callback.name,
              callbackNumber: record.callback.number,
              callbackReason: record.callback.reason,
            }
          : {}),
      })
      .where(eq(phoneCalls.callId, callId));
    await recordAuditEvent(auditStore, {
      eventType: "phone.call_ended",
      targetType: "phone_line",
      targetId: LINE_ID,
      initiator: { kind: "deployment" },
      payload: { call: callId, outcome: record.outcome },
    });
  }

  function onRelayMessage(raw: unknown) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const callId = typeof message.callId === "string" ? message.callId : "";
    switch (message.type) {
      case "hello":
        status = "connected";
        problem = null;
        backoff = 1000;
        return;
      case "call.start":
        if (callId && !bridges.has(callId)) {
          void answer(
            callId,
            typeof message.from === "string" ? message.from : "",
          ).catch((error) => {
            console.error(
              "Phone line: could not answer a call:",
              error instanceof Error ? error.message : error,
            );
            sendToRelay({ type: "transfer", callId });
          });
        }
        return;
      case "media":
        if (typeof message.payload === "string")
          bridges.get(callId)?.audio(message.payload);
        return;
      case "call.end":
        bridges.get(callId)?.ended();
        return;
      case "call.status":
        if (
          callId &&
          typeof message.duration === "number" &&
          message.duration > 0
        ) {
          void database
            .update(phoneCalls)
            .set({ durationSeconds: Math.round(message.duration) })
            .where(eq(phoneCalls.callId, callId))
            .catch(() => undefined);
        }
        return;
    }
  }

  async function takeLock(): Promise<boolean> {
    if (releaseLock) return true;
    const client = database.$client as unknown as {
      reserve?: () => Promise<{
        (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ): Promise<{ locked: boolean }[]>;
        release: () => void;
      }>;
    };
    if (!client.reserve) return true;
    const reserved = await client.reserve();
    const [row] =
      await reserved`select pg_try_advisory_lock(${LOCK_KEY}) as locked`;
    if (!row?.locked) {
      reserved.release();
      return false;
    }
    releaseLock = async () => {
      await reserved`select pg_advisory_unlock(${LOCK_KEY})`.catch(
        () => undefined,
      );
      reserved.release();
    };
    return true;
  }

  function schedule() {
    if (stopped) return;
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  async function connect() {
    if (stopped) return;
    try {
      const row = await load();
      if (!row?.enabled) {
        status = "off";
        return;
      }
      if (!(await takeLock())) {
        // Another process on this database holds the line; check again later.
        status = "connecting";
        backoff = 30_000;
        return schedule();
      }
      const url = lineSocketUrl(row.relayUrl, dependencies.allowInsecureRelay);
      if (!url) {
        status = "refused";
        problem = "The relay address must start with https://.";
        return;
      }
      const token = await secret(row.lineCredentialId);
      status = "connecting";
      const opened = openSocket(url, token);
      socket = opened;
      opened.onmessage = (event) => onRelayMessage(event.data);
      opened.onclose = (event) => {
        if (socket !== opened) return;
        socket = null;
        for (const bridge of bridges.values()) bridge.ended();
        if (event.code === 4000) {
          // Another install connected for this line: it answers now, and this one stands down.
          status = "refused";
          problem = "Another computer is answering this line now.";
          return;
        }
        status = "connecting";
        if (event.code !== 1000) {
          problem =
            "The relay could not be reached, or it refused this line token. Trying again.";
        }
        schedule();
      };
      opened.onerror = () => undefined;
    } catch (error) {
      status = "connecting";
      problem = "The relay could not be reached. Trying again.";
      console.error(
        "Phone line:",
        error instanceof Error ? error.message : error,
      );
      schedule();
    }
  }

  function restart() {
    if (stopped) return;
    const old = socket;
    socket = null;
    old?.close(1000);
    backoff = 1000;
    void connect();
  }

  return {
    async settings(): Promise<PhoneLineView | null> {
      return view(await load());
    },
    save,
    remove,
    calls,
    markCallbackDone,
    /** Starts answering, if a line is set up. Safe to call once at start. */
    start() {
      stopped = false;
      void connect();
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close(1000);
      socket = null;
      for (const bridge of bridges.values()) bridge.ended();
      await releaseLock?.();
      releaseLock = null;
    },
    /** For tests. */
    get liveCalls() {
      return bridges.size;
    },
  };
}

export type PhoneLineService = ReturnType<typeof createPhoneLineService>;
