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
 * BEFORE ACTIVATION (Amgad, 23 Nov 2026). On a desktop install that has no trial file, code or
 * licence yet, the person can still write: the request goes as customer "unverified", with this
 * install's random id, no proof, and an email address only if they choose to give one. blackark.uk
 * limits these to 3 a day per install and per address, and BlackArk's board marks the case
 * unverified.
 *
 * WHERE. blackark.uk/checkin/support/ checks the proof and forwards the request to BlackArk's
 * support board, which answers a case number. If it cannot be reached, the request waits here and
 * is sent again every hour with the same id, so it becomes one case, never two.
 *
 * REPLIES (Gap 3, Amgad 23 Nov 2026). BlackArk's answers come back the same way:
 * blackark.uk/checkin/support/replies/ takes this install's id and the same proof (none before
 * activation) and gives the replies to this install's cases. Nothing else is sent to ask, and the
 * replies are not kept here: each person sees only those to their own requests.
 */
import { randomUUID } from "node:crypto";
import { arch, release, type } from "node:os";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { supportInstall, supportRequests } from "../db/schema";
import { type InstallProof, installIdentity } from "../trial/install-proof";
import type { RecentLogs } from "./scrub";

export const DEFAULT_SUPPORT_URL = "https://blackark.uk/checkin/support/";
const HOUR = 60 * 60 * 1000;
const PREVIEW_MS = 30 * 60 * 1000;
/** The customer id of a request from an install that is not activated yet. */
export const UNVERIFIED_CUSTOMER = "unverified";

export type SupportInput = {
  subject: string;
  message: string;
  urgent: boolean;
  includeDiagnostics: boolean;
  language: "el" | "en";
  /** Only before activation, and only if the person gives one: where BlackArk may answer. */
  contactEmail?: string | null;
};

export type SupportProof = InstallProof;

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
  /** BlackArk's own proof of whose install this is; null before activation (customer "unverified"). */
  proof: SupportProof | null;
  /** Present only on a request sent before activation: the address the person gave, or null. */
  contactEmail?: string | null;
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

/** One case of this install, as BlackArk's board gives it, with its replies. */
export type SupportReplyCase = {
  case: number;
  status: "new" | "open" | "waiting" | "solved" | "closed";
  replies: Array<{
    at: string;
    language: "el" | "en";
    text: string;
    english: string | null;
  }>;
};

const REPLIES_FRESH_MS = 2 * 60 * 1000;

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
    /** Where the replies are asked for; by default `url` with "replies/" after it. */
    repliesUrl?: string;
    /**
     * A desktop install, where activation is required: with no trial or licence yet, a request
     * still goes, unverified. Elsewhere Help & support needs BlackArk's proof, as before.
     */
    beforeActivation?: boolean;
    fetch?: typeof fetch;
    now?: () => Date;
    system?: () => string;
  },
) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const url = options.url ?? DEFAULT_SUPPORT_URL;
  const repliesUrl =
    options.repliesUrl ?? `${url.replace(/\/+$/, "")}/replies/`;
  /** The last answer, for two minutes: blackark.uk allows each install 60 asks an hour. */
  let replyCache: { at: number; cases: SupportReplyCase[] } | null = null;
  const system = options.system ?? systemDescription;
  /** What each person was shown, kept 30 minutes, so what they send is exactly what they read. */
  const previews = new Map<
    string,
    { userId: string; payload: SupportPayload; at: number }
  >();

  function sameRequest(payload: SupportPayload, input: SupportInput): boolean {
    return (
      (payload.contactEmail ?? null) === contactOf(input) &&
      payload.subject === input.subject.trim() &&
      payload.message === input.message.trim() &&
      payload.urgent === input.urgent &&
      payload.language === input.language &&
      (payload.diagnostics !== null) === input.includeDiagnostics
    );
  }

  function contactOf(input: SupportInput): string | null {
    return input.contactEmail?.trim() || null;
  }

  /** This install's own random id before activation, made once. */
  async function unverifiedInstallId(): Promise<string> {
    await database.insert(supportInstall).values({}).onConflictDoNothing();
    const [row] = await database.select().from(supportInstall).limit(1);
    if (!row) throw new Error("The install id could not be kept.");
    return row.installId;
  }

  async function build(
    input: SupportInput,
    requestId: string,
  ): Promise<SupportPayload> {
    const who = await installIdentity(database);
    if (!who && !options.beforeActivation) throw new SupportUnavailableError();
    const unverified = who === null;
    return {
      requestId,
      customerId: who?.customerId ?? UNVERIFIED_CUSTOMER,
      installId: who?.installId ?? (await unverifiedInstallId()),
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
      proof: who?.proof ?? null,
      // Only an unverified request may carry an address; blackark.uk refuses it on any other.
      ...(unverified ? { contactEmail: contactOf(input) } : {}),
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
    /** Whether this install can send a request at all (it needs BlackArk's proof, or a desktop install). */
    async available(): Promise<boolean> {
      return (
        options.beforeActivation === true ||
        (await installIdentity(database)) !== null
      );
    },

    /** Whether a request from here names a customer, with BlackArk's proof; false before activation. */
    async verified(): Promise<boolean> {
      return (await installIdentity(database)) !== null;
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

    /**
     * BlackArk's replies to this person's own requests, by case number; null when they cannot be
     * fetched now (not activated where that is needed, or blackark.uk not reachable).
     */
    async replies(userId: string): Promise<SupportReplyCase[] | null> {
      const mine = new Set(
        (await this.list(userId))
          .map((one) => one.caseNumber)
          .filter((number): number is number => number !== null),
      );
      if (mine.size === 0) return [];
      const at = now().getTime();
      if (!replyCache || at - replyCache.at > REPLIES_FRESH_MS) {
        const who = await installIdentity(database);
        if (!who && !options.beforeActivation) return null;
        try {
          const response = await send(repliesUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              customerId: who?.customerId ?? UNVERIFIED_CUSTOMER,
              installId: who?.installId ?? (await unverifiedInstallId()),
              proof: who?.proof ?? null,
            }),
            signal: AbortSignal.timeout(20_000),
          });
          const answer = (await response.json().catch(() => null)) as {
            cases?: unknown;
          } | null;
          if (!response.ok || !Array.isArray(answer?.cases)) return null;
          replyCache = { at, cases: readReplyCases(answer.cases) };
        } catch {
          return null;
        }
      }
      return replyCache.cases.filter((one) => mine.has(one.case));
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

const STATUSES = new Set(["new", "open", "waiting", "solved", "closed"]);

/** Only well-formed cases and replies, whatever blackark.uk answered. */
function readReplyCases(raw: unknown[]): SupportReplyCase[] {
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.length <= max ? value : null;
  const out: SupportReplyCase[] = [];
  for (const one of raw.slice(0, 20)) {
    if (!one || typeof one !== "object") continue;
    const row = one as Record<string, unknown>;
    if (typeof row.case !== "number" || !Array.isArray(row.replies)) continue;
    out.push({
      case: row.case,
      status: (STATUSES.has(String(row.status))
        ? row.status
        : "open") as SupportReplyCase["status"],
      replies: row.replies.slice(0, 50).flatMap((reply) => {
        const r = (reply ?? {}) as Record<string, unknown>;
        const body = text(r.text, 40_000);
        const at = text(r.at, 40);
        if (body === null || at === null) return [];
        return [
          {
            at,
            language: r.language === "el" ? ("el" as const) : ("en" as const),
            text: body,
            english: text(r.english, 40_000),
          },
        ];
      }),
    });
  }
  return out;
}
