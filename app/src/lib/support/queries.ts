import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/**
 * Help & support (#149): the person's requests to BlackArk from this computer.
 *
 * `payload` is exactly what was (or will be) sent, so the screen can show it again. The proof in it
 * is BlackArk's own signed trial file or licence key, as BlackArk issued it; before activation there
 * is none, the customer is "unverified", and the person may have given an email address.
 */
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
  proof:
    | { kind: "profile"; profile: string; signature: string }
    | { kind: "code"; payload: string; signature: string }
    | null;
  /** Only on a request sent before activation: the address the person gave, or null. */
  contactEmail?: string | null;
};

export type SupportRequest = {
  id: string;
  subject: string;
  /** queued: not sent yet, sent again every hour; sent: BlackArk opened a case; refused: not taken. */
  status: "queued" | "sent" | "refused";
  caseNumber: number | null;
  createdAt: string;
  sentAt: string | null;
  lastError: string | null;
  payload: SupportPayload;
};

export type SupportState = {
  /** False until this computer is activated with a BlackArk trial or licence. */
  available: boolean;
  /**
   * False before activation (Amgad, 23 Nov 2026): a request still goes, but BlackArk cannot tell whose
   * computer it is, so the person may give an email address. Absent from an older server: true.
   */
  verified?: boolean;
  requests: SupportRequest[];
};

/** One of the person's cases, as BlackArk's board gives it back, with BlackArk's replies (Gap 3). */
export type SupportReplyCase = {
  case: number;
  status: "new" | "open" | "waiting" | "solved" | "closed";
  replies: Array<{
    at: string;
    /** The customer's language, which the reply is written in; `english` is the copy below it. */
    language: "el" | "en";
    text: string;
    english: string | null;
  }>;
};

export const supportKeys = {
  all: ["support"] as const,
  state: ["support", "state"] as const,
  replies: ["support", "replies"] as const,
};

/** The requests, or null when this server does not offer Help & support. */
export function supportStateQueryOptions() {
  return queryOptions({
    queryKey: supportKeys.state,
    queryFn: async (): Promise<SupportState | null> => {
      const response = await tryClient("/api/support").catch(() => null);
      if (response?.status !== 200) return null;
      return (await response.json()) as SupportState;
    },
  });
}

/**
 * BlackArk's replies to the person's own requests, by case; null when they cannot be fetched now
 * (an older server, not activated, or blackark.uk not reachable). Asked again every five minutes
 * while the screen is open.
 */
export function supportRepliesQueryOptions() {
  return queryOptions({
    queryKey: supportKeys.replies,
    queryFn: async (): Promise<SupportReplyCase[] | null> => {
      const response = await tryClient("/api/support/replies").catch(
        () => null,
      );
      if (response?.status !== 200) return null;
      const body = (await response.json()) as {
        available: boolean;
        cases: SupportReplyCase[];
      };
      return body.available ? body.cases : null;
    },
    refetchInterval: 5 * 60 * 1000,
  });
}
