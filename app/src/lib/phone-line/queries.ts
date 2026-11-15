import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** The business's phone line (#109), as an administrator sees it. Never the token or the key. */
export type PhoneLineHours = Partial<
  Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", { from: string; to: string }>
>;

export type PhoneLine = {
  relayUrl: string;
  agentId: string;
  speechModel: string;
  voice: string;
  greeting: string;
  hours: PhoneLineHours | null;
  enabled: boolean;
  status: "connected" | "connecting" | "off" | "refused";
  problem: string | null;
};

export type PhoneCall = {
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

export const phoneLineKeys = {
  all: ["phone-line"] as const,
  line: () => [...phoneLineKeys.all, "line"] as const,
  calls: () => [...phoneLineKeys.all, "calls"] as const,
};

export function phoneLineQueryOptions() {
  return queryOptions({
    queryKey: phoneLineKeys.line(),
    queryFn: (): Promise<PhoneLine | null> =>
      client("/api/phone-line", "line", {
        fallback: "Could not load the phone line",
      }),
    refetchInterval: 10_000,
  });
}

export function phoneCallsQueryOptions() {
  return queryOptions({
    queryKey: phoneLineKeys.calls(),
    queryFn: (): Promise<PhoneCall[]> =>
      client("/api/phone-line/calls", "calls", {
        fallback: "Could not load the call log",
      }),
    refetchInterval: 15_000,
  });
}
