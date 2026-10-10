import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { authKeys } from "@/lib/auth/queries";
import { client } from "@/lib/client";
import type { Grant } from "./sign-in";

/**
 * Turn the code the system browser handed back into a session for this app.
 *
 * The server checks the code, the state and the secret together, accepts a code once, and answers
 * with a session cookie of its own that the app's web view then holds. The person is whoever the code
 * was issued to, which is whoever signed in in the browser a moment ago.
 */
export function exchangeNativeSignInMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (grant: Grant): Promise<void> => {
      await client("/api/auth/electron/token", {
        method: "POST",
        body: {
          token: grant.code,
          state: grant.state,
          code_verifier: grant.verifier,
        },
        fallback: "Could not finish signing in",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: authKeys.all,
        refetchType: "all",
      }),
  });
}
