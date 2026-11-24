import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The weekly summary and chat cleanup of one digital employee (Amgad, 24 Nov 2026): whether it is on,
 * the summary file it starts every request from, and when it was last made.
 */
export type ChatSummaryState = {
  enabled: boolean;
  /** On because the employee is new (the default), not because the person chose it. */
  isDefault: boolean;
  summary: string;
  summaryTokens: number;
  summarisedAt: string | null;
  lastError: string | null;
  /** Amgad's words, shown before switching it off. */
  warning: string;
};

export const chatSummaryKeys = {
  all: ["chat-summary"] as const,
  one: (agentId: string) => ["chat-summary", agentId] as const,
};

export const chatSummaryPath = (agentId: string) =>
  `/api/chat-summary/${encodeURIComponent(agentId)}`;

/** Sends the person's time zone, so the weekly run falls on their own Sunday night. */
export function chatSummaryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: chatSummaryKeys.one(agentId),
    queryFn: async (): Promise<ChatSummaryState> => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
      const response = await client(
        `${chatSummaryPath(agentId)}?tz=${encodeURIComponent(zone)}`,
        { fallback: "The weekly summary could not be loaded." },
      );
      return (await response.json()) as ChatSummaryState;
    },
  });
}
