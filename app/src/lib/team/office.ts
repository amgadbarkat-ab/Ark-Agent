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
  /** Remote staff through BlackArk's staff relay (v0.1.56). */
  remote: {
    available: boolean;
    enabled: boolean;
    connected: boolean;
    error: string | null;
  };
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

async function answered(response: Response): Promise<OfficeStatus> {
  const answer = (await response.json().catch(() => ({}))) as
    | OfficeStatus
    | { error?: string };
  if (!response.ok)
    throw new Error(
      ("error" in answer && answer.error) || "That did not work. Try again.",
    );
  return answer as OfficeStatus;
}

/** Remote staff on or off. */
export function setRemoteStaffMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (remote: boolean): Promise<OfficeStatus> =>
      answered(
        await tryClient("/api/team/office", {
          method: "PUT",
          body: { remote },
        }),
      ),
    onSuccess: (status) => queryClient.setQueryData(officeKey, status),
  });
}

/** A new join code: the old one stops getting through BlackArk's relay. */
export function newJoinCodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<OfficeStatus> =>
      answered(
        await tryClient("/api/team/office/join-code", { method: "POST" }),
      ),
    onSuccess: (status) => queryClient.setQueryData(officeKey, status),
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
