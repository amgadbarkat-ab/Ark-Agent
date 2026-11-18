import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ArkLinkPairing, arkLinkKeys } from "./queries";

/** What an administrator sends. The install token only when it is typed in. */
export type ArkLinkForm = {
  relayUrl: string;
  installToken?: string;
  enabled: boolean;
};

const refresh = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: arkLinkKeys.all });

export function saveArkLinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (form: ArkLinkForm) =>
      (
        await client("/api/ark-link", {
          method: "PUT",
          body: form,
          fallback: "The phone settings could not be saved",
        })
      ).json(),
    onSuccess: refresh(queryClient),
  });
}

export function startPairingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<ArkLinkPairing> =>
      (
        await client("/api/ark-link/pairing", {
          method: "POST",
          fallback: "Could not get a pairing code",
        })
      ).json(),
    onSuccess: refresh(queryClient),
  });
}

export function acceptPhoneMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/ark-link/devices/${encodeURIComponent(id)}/accept`, {
        method: "POST",
        fallback: "The phone could not be accepted",
      });
    },
    onSuccess: refresh(queryClient),
  });
}

export function confirmPhoneMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      pairingId: string;
      deviceName: string;
      /** Who the phone is for; absent is the person confirming. */
      forUserId?: string;
    }) =>
      (
        await client(
          `/api/ark-link/pairing/${encodeURIComponent(input.pairingId)}/confirm`,
          {
            method: "POST",
            body: {
              deviceName: input.deviceName,
              ...(input.forUserId ? { forUserId: input.forUserId } : {}),
            },
            fallback: "The phone could not be paired",
          },
        )
      ).json(),
    onSuccess: refresh(queryClient),
  });
}

export function refusePhoneMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (pairingId: string) => {
      await client(
        `/api/ark-link/pairing/${encodeURIComponent(pairingId)}/refuse`,
        { method: "POST", fallback: "Could not decline the phone" },
      );
    },
    onSuccess: refresh(queryClient),
  });
}

export function removePhoneMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string) => {
      await client(`/api/ark-link/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "The phone could not be removed",
      });
    },
    onSuccess: refresh(queryClient),
  });
}
