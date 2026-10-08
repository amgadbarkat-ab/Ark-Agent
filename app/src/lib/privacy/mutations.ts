import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { peopleKeys } from "@/lib/people/queries";

/**
 * What a person asks of their data.
 *
 * Getting a copy is not here: it is a plain link to `/api/account/export`, because it is a download
 * the browser handles, not data the screen holds.
 */

/** The address a person's export comes from. A link, never a request the page makes. */
export const MY_EXPORT_PATH = "/api/account/export";

export function personExportPath(userId: string): string {
  return `/api/admin/people/${encodeURIComponent(userId)}/export`;
}

/**
 * Remove the signed-in person and what is theirs. Cannot be undone.
 *
 * Everything the screen has cached is theirs, so it is all dropped on success rather than refetched:
 * a refetch would find nobody signed in.
 */
export function deleteMyAccountMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      confirmEmail: string,
    ): Promise<{ ok: true; accountRemoved: boolean }> =>
      (
        await client("/api/account/delete", {
          method: "POST",
          body: { confirmEmail },
          fallback: "Could not delete the account",
        })
      ).json(),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

/** Staff: remove somebody who asked to be removed. */
export function erasePersonMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      userId: string;
      confirmEmail: string;
    }): Promise<{ ok: true; followUp: string[] }> =>
      (
        await client(`/api/admin/people/${variables.userId}/erase`, {
          method: "POST",
          body: { confirmEmail: variables.confirmEmail },
          fallback: "Could not remove that person",
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: peopleKeys.all }),
  });
}
