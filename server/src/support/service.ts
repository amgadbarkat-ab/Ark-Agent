/**
 * Help & support (#149; Amgad, 18 Nov 2026: in-app support is BlackArk's only support channel).
 *
 * WHAT IS SENT, and only after the person has seen it: their subject and words, whether it stops
 * their work, their language, this install's random id, the customer id, the app version, and the
 * proof that this is a real install of that customer: BlackArk's own signed trial file, activation
 * code or licence key, exactly as BlackArk issued it. Nothing the person wrote besides the request.
 *
 * DIAGNOSTICS, only when the person ticks them: the app version, the kind of system, and recent
 * warnings and errors, scrubbed (scrub.ts). Never conversations, mail, files or keys.
 *
 * WHERE. blackark.uk/checkin/support/ checks the proof and forwards the request to BlackArk's
 * support board, which answers a case number. If it cannot be reached, the request waits here and
 * is sent again every hour with the same id, so it becomes one case, never two.
 */
import { randomUUID } from "node:crypto";
import { arch, release, type } from "node:os";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { activationState, supportRequests, trialState } from "../db/schema";
import type { RecentLogs } from "./scrub";

export const DEFAULT_SUPPORT_URL = "https://blackark.uk/checkin/support/";
const HOUR = 60 * 60 * 1000;
const PREVIEW_MS = 30 * 60 * 1000;

export type SupportInput = {
  subject: string;
  message: string;
  urgent: boolean;
  includeDiagnostics: boolean;
  language: "el" | "en";
};

export type SupportProof =
  | { kind: "profile"; profile: string; signature: string }
  | { kind: "code"; payload: string; signature: string };

/** Exactly what is sent, as the person sees it before sending. */
export type SupportPayload = {
  requestId: string;
  customerId: string;
  installId: string;
  appVersion: string;
  language: "el" | "en";
  subject: string;
  message: string;
  urgent: boolean;
  diagnostics: { appVersion: string; os: string; logs: string[] } | null;
  proof: SupportProof;
};

export type SupportRequestView = {
  id: string;
  subject: string;
  status: "queued" | "sent" | "refused";
  caseNumber: number | null;
  createdAt: string;
  sentAt: string | null;
  /** A sentence the app shows, when the last attempt did not work. */
  lastError: string | null;
  /** What was sent (or will be), exactly. */
  payload: SupportPayload;
};

export class SupportUnavailableError extends Error {
  constructor() {
    super(
      "Help & support needs this computer to be activated with a BlackArk trial or licence first.",
    );
    this.name = "SupportUnavailableError";
  }
}

type Row = typeof supportRequests.$inferSelect;

function view(row: Row): SupportRequestView {
  const payload = JSON.parse(row.body) as SupportPayload;
  return {
    id: row.id,
    subject: payload.subject,
    status: row.status as SupportRequestView["status"],
    caseNumber: row.caseNumber,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    lastError: row.lastError,
    payload,
  };
}

export function systemDescription(): string {
  const names: Record<string, string> = {
    Windows_NT: "Windows",
    Darwin: "macOS",
    Linux: "Linux",
  };
  return `${names[type()] ?? type()} ${release()} (${arch()})`;
}

export type SupportService = ReturnType<typeof createSupportService>;

export function createSupportService(
  database: Database,
  options: {
    version: string;
    logs?: RecentLogs;
    url?: string;
    fetch?: typeof fetch;
    now?: () => Date;
    system?: () => string;
  },
) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const url = options.url ?? DEFAULT_SUPPORT_URL;
  const system = options.system ?? systemDescription;
  /** What each person was shown, kept 30 minutes, so what they send is exactly what they read. */
  const previews = new Map<
    string,
    { userId: string; payload: SupportPayload; at: number }
  >();

  function sameRequest(payload: SupportPayload, input: SupportInput): boolean {
    return (
      payload.subject === input.subject.trim() &&
      payload.message === input.message.trim() &&
      payload.urgent === input.urgent &&
      payload.language === input.language &&
      (payload.diagnostics !== null) === input.includeDiagnostics
    );
  }

  /** Who this install is, and BlackArk's own proof of it: a licence first, then the trial file. */
  async function identity(): Promise<{
    customerId: string;
    installId: string;
    proof: SupportProof;
  } | null> {
    const [activation] = await database.select().from(activationState).limit(1);
    if (activation?.kind === "license") {
      return {
        customerId: activation.customerId,
        installId: activation.installId,
        proof: {
          kind: "code",
          payload: activation.payload,
          signature: activation.signature,
        },
      };
    }
    const [trial] = await database.select().from(trialState).limit(1);
    if (trial) {
      return {
        customerId: trial.customerId,
        installId: trial.installId,
        proof: {
          kind: "profile",
          profile: trial.profile,
          signature: trial.signature,
        },
      };
    }
    if (activation) {
      return {
        customerId: activation.customerId,
        installId: activation.installId,
        proof: {
          kind: "code",
          payload: activation.payload,
          signature: activation.signature,
        },
      };
    }
    return null;
  }

  async function build(
    input: SupportInput,
    requestId: string,
  ): Promise<SupportPayload> {
    const who = await identity();
    if (!who) throw new SupportUnavailableError();
    return {
      requestId,
      customerId: who.customerId,
      installId: who.installId,
      appVersion: options.version,
      language: input.language,
      subject: input.subject.trim(),
      message: input.message.trim(),
      urgent: input.urgent,
      diagnostics: input.includeDiagnostics
        ? {
            appVersion: options.version,
            os: system().slice(0, 80),
            logs: options.logs?.lines(now().getTime(), 50) ?? [],
          }
        : null,
      proof: who.proof,
    };
  }

  /** One attempt. Updates the row; never throws. */
  async function deliver(row: Row): Promise<Row> {
    let update: Partial<Row>;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: row.body,
        signal: AbortSignal.timeout(20_000),
      });
      const answer = (await response.json().catch(() => ({}))) as {
        case?: unknown;
      };
      if (response.ok && typeof answer.case === "number") {
        update = {
          status: "sent",
          caseNumber: answer.case,
          sentAt: now(),
          lastError: null,
        };
      } else if (
        response.status === 400 ||
        response.status === 403 ||
        response.status === 413
      ) {
        update = {
          status: "refused",
          lastError:
            "BlackArk did not accept this request. Please contact BlackArk another way.",
        };
      } else {
        update = {
          lastError:
            response.status === 429
              ? "Too many requests today. It will be sent again later."
              : "BlackArk could not be reached. It will be sent again.",
        };
      }
    } catch {
      update = {
        lastError: "BlackArk could not be reached. It will be sent again.",
      };
    }
    const [saved] = await database
      .update(supportRequests)
      .set({ ...update, attempts: row.attempts + 1 })
      .where(eq(supportRequests.id, row.id))
      .returning();
    return saved ?? row;
  }

  return {
    /** Whether this install can send a request at all (it needs BlackArk's proof). */
    async available(): Promise<boolean> {
      return (await identity()) !== null;
    },

    /** Exactly what would be sent, for the person to read first. */
    async preview(
      userId: string,
      input: SupportInput,
    ): Promise<SupportPayload> {
      const payload = await build(input, randomUUID());
      const at = now().getTime();
      for (const [id, kept] of previews)
        if (at - kept.at > PREVIEW_MS) previews.delete(id);
      previews.set(payload.requestId, { userId, payload, at });
      return payload;
    },

    /**
     * Keeps the request, then tries to send it once now. With the id of the preview the person
     * read, it sends that very payload; otherwise it builds one the same way.
     */
    async submit(
      userId: string,
      input: SupportInput,
      previewId?: string,
    ): Promise<SupportRequestView> {
      const shown = previewId ? previews.get(previewId) : undefined;
      const payload =
        shown && shown.userId === userId && sameRequest(shown.payload, input)
          ? shown.payload
          : await build(input, randomUUID());
      if (previewId) previews.delete(previewId);
      const [row] = await database
        .insert(supportRequests)
        .values({
          id: payload.requestId,
          userId,
          body: JSON.stringify(payload),
        })
        .returning();
      if (!row) throw new Error("The request could not be kept.");
      return view(await deliver(row));
    },

    /** This person's requests on this install, newest first. */
    async list(userId: string): Promise<SupportRequestView[]> {
      const rows = await database
        .select()
        .from(supportRequests)
        .where(eq(supportRequests.userId, userId))
        .orderBy(desc(supportRequests.createdAt))
        .limit(50);
      return rows.map(view);
    },

    /** Sends every waiting request again. Returns how many were sent. */
    async retry(): Promise<number> {
      const waiting = await database
        .select()
        .from(supportRequests)
        .where(and(eq(supportRequests.status, "queued")));
      let sent = 0;
      for (const row of waiting) {
        if ((await deliver(row)).status === "sent") sent += 1;
      }
      return sent;
    },

    /** Every hour, and a minute after start. Returns the stop function. */
    startRetries(): () => void {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          await this.retry();
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "support-retry-failed",
              errorName: (error as Error)?.name,
            }),
          );
        }
      };
      const first = setTimeout(tick, 60_000);
      const every = setInterval(tick, HOUR);
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
