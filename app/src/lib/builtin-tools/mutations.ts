import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { sentenceNow } from "@/lib/i18n";
import { builtinToolKeys } from "./queries";

/**
 * Upload the price list as the file's own bytes: `client` sends JSON only, and an 8 MB workbook
 * as base64 JSON would be a third larger and over the JSON limit.
 */
export function uploadPriceListMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (file: File) => {
      const response = await fetch("/api/price-list", {
        method: "PUT",
        credentials: "include",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          sentenceNow(body?.error ?? "The price list could not be uploaded"),
        );
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: builtinToolKeys.priceList() }),
  });
}

export function removePriceListMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () => {
      await client("/api/price-list", {
        method: "DELETE",
        fallback: "The price list could not be removed",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: builtinToolKeys.priceList() }),
  });
}
