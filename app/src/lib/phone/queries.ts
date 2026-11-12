import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/** Approving by phone (P2 idea 10). The routes exist only when an administrator turned it on. */
export type PhoneSettings = {
  provider: string;
  phone: string | null;
  hasPin: boolean;
  agentIds: string[];
};

export type PhoneCall = {
  id: string;
  approvalId: string;
  step: "ringing" | "pin" | "choose" | "ended";
  outcome: string | null;
  said: string;
  startedAt: string;
};

export const phoneKeys = {
  settings: ["phone-approval", "settings"] as const,
  calls: ["phone-approval", "calls"] as const,
};

/** The person's settings, or null when this deployment does not offer phone approval. */
export function phoneSettingsQueryOptions() {
  return queryOptions({
    queryKey: phoneKeys.settings,
    queryFn: async (): Promise<PhoneSettings | null> => {
      const response = await tryClient("/api/phone-approval/settings").catch(
        () => null,
      );
      if (response?.status !== 200) return null;
      return (await response.json()) as PhoneSettings;
    },
    retry: false,
  });
}

export function savePhoneSettingsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      phone: string;
      pin?: string;
      agentIds: string[];
    }) => {
      await client("/api/phone-approval/settings", {
        method: "PUT",
        body: input,
        fallback: "Phone approval could not be saved.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: phoneKeys.settings }),
  });
}

/** Calls ringing or going on for this person: the simulated phone. Asked every two seconds. */
export function phoneCallsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: phoneKeys.calls,
    queryFn: async (): Promise<PhoneCall[]> => {
      const response = await tryClient("/api/phone-approval/calls").catch(
        () => null,
      );
      if (response?.status !== 200) return [];
      return ((await response.json()) as { calls: PhoneCall[] }).calls;
    },
    enabled,
    refetchInterval: enabled ? 2_000 : false,
    retry: false,
  });
}

/** Answer, press keys on, or hang up a simulated call. */
export function phoneCallActionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      callId: string;
      action: "answer" | "keys" | "hang-up";
      keys?: string;
    }): Promise<PhoneCall | null> => {
      const response = await client(
        `/api/phone-approval/calls/${encodeURIComponent(input.callId)}/${input.action}`,
        {
          method: "POST",
          ...(input.keys ? { body: { keys: input.keys } } : {}),
          fallback: "The call could not be answered.",
        },
      );
      if (response.status === 204) return null;
      return ((await response.json()) as { call: PhoneCall }).call;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: phoneKeys.calls });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
