import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { modelKeys } from "@/lib/models/queries";
import { privateServerKeys } from "./queries";

/** Puts the ready private server into the person's models and makes it their default. */
export function connectPrivateServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () =>
      (
        await client("/api/private-server/connect", {
          method: "POST",
          fallback: "The private server could not be connected",
        })
      ).json(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: privateServerKeys.all });
      await queryClient.invalidateQueries({ queryKey: modelKeys.all });
    },
  });
}
