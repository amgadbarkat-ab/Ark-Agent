import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/**
 * Help & support (#149): the person's requests to BlackArk from this computer.
 *
 * `payload` is exactly what was (or will be) sent, so the screen can show it again. The proof in it
 * is BlackArk's own signed trial file or licence key, as BlackArk issued it.
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
    | { kind: "code"; payload: string; signature: string };
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
  requests: SupportRequest[];
};

export const supportKeys = {
  all: ["support"] as const,
  state: ["support", "state"] as const,
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
