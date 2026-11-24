import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { tryClient } from "@/lib/client";

/**
 * The office network (Amgad, 24 Nov 2026, option A): whether staff computers on the same network
 * can sign in to this one, and the join code to give them. Null where it is not offered (a hosted
 * deployment, or no team).
 */
export type OfficeStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  addresses: string[];
  fingerprint: string | null;
  joinCode: string | null;
  error: string | null;
};

const officeKey = ["team", "office"] as const;

export function officeQueryOptions() {
  return queryOptions({
    queryKey: officeKey,
    queryFn: async (): Promise<OfficeStatus | null> => {
      const response = await tryClient("/api/team/office").catch(() => null);
      if (response?.status !== 200) return null;
      return (await response.json()) as OfficeStatus;
    },
  });
}

export function setOfficeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (enabled: boolean): Promise<OfficeStatus> => {
      const response = await tryClient("/api/team/office", {
        method: "PUT",
        body: { enabled },
      });
      const answer = (await response.json().catch(() => ({}))) as
        | OfficeStatus
        | { error?: string };
      if (!response.ok)
        throw new Error(
          ("error" in answer && answer.error) ||
            "That did not work. Try again.",
        );
      return answer as OfficeStatus;
    },
    onSuccess: (status) => queryClient.setQueryData(officeKey, status),
  });
}
