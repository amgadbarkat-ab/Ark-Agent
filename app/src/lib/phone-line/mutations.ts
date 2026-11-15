import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type PhoneLineHours, phoneLineKeys } from "./queries";

/** What an administrator sends. The token and the key only when they are typed in. */
export type PhoneLineForm = {
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

export function savePhoneLineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (form: PhoneLineForm) =>
      (
        await client("/api/phone-line", {
          method: "PUT",
          body: form,
          fallback: "The phone line could not be saved",
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: phoneLineKeys.all }),
  });
}

export function removePhoneLineMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () => {
      await client("/api/phone-line", {
        method: "DELETE",
        fallback: "The phone line could not be removed",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: phoneLineKeys.all }),
  });
}

export function callbackDoneMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(
        `/api/phone-line/calls/${encodeURIComponent(id)}/callback-done`,
        {
          method: "POST",
          fallback: "Could not mark the callback as done",
        },
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: phoneLineKeys.calls() }),
  });
}
