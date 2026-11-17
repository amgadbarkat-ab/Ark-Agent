import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { pluginKeys } from "@/lib/plugins/queries";
import { businessFileKeys } from "./queries";

/** A business connector's login (#109, v0.1.43). Secrets go to the server once and never come back. */
export function connectBusinessMutationOptions(
  queryClient: QueryClient,
  key: string,
) {
  return mutationOptions({
    mutationFn: async (
      fields: Record<string, string>,
    ): Promise<{ connected: true; account: string }> =>
      (
        await client(`/api/plugins/business/${key}/connection`, {
          method: "POST",
          body: fields,
          fallback: "The connector could not be connected",
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });
}

export function disconnectBusinessMutationOptions(
  queryClient: QueryClient,
  key: string,
) {
  return mutationOptions({
    mutationFn: async (): Promise<{ disconnected: boolean }> =>
      (
        await client(`/api/plugins/business/${key}/connection`, {
          method: "DELETE",
          fallback: "The connector could not be disconnected",
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });
}

/** Uploads one data file under a short name; a new one replaces the old. */
export function uploadBusinessFileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { name: string; file: File }) => {
      const response = await fetch(
        `/api/business-files/${encodeURIComponent(input.name)}`,
        {
          method: "PUT",
          credentials: "include",
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(input.file.name),
          },
          body: await input.file.arrayBuffer(),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "The file could not be uploaded");
      }
      return response.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: businessFileKeys.all }),
  });
}

export function removeBusinessFileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string) => {
      await client(`/api/business-files/${encodeURIComponent(name)}`, {
        method: "DELETE",
        fallback: "The file could not be removed",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: businessFileKeys.all }),
  });
}
