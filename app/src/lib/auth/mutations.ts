import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { authKeys, type TermsStatus } from "./queries";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "Could not sign out",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => queryClient.removeQueries({ queryKey: authKeys.all }),
  });
}

/**
 * Accept the terms, naming the version that was on screen.
 *
 * The server refuses (409) if the version in force has changed since, and says which it is now, so
 * a person is never recorded as having agreed to a text they were not shown. The status lives on the
 * current user, so that is what a write refreshes, for every observer or not: the `_authed` gate reads
 * it through `ensureQueryData` and takes the cache as it finds it.
 */
export function acceptTermsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (version: string): Promise<TermsStatus> =>
      client("/api/me/terms", "terms", {
        method: "POST",
        body: { version },
        fallback: "Your acceptance could not be saved",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: authKeys.currentUser(),
        refetchType: "all",
      }),
  });
}
