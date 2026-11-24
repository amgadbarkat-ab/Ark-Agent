import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { tNow } from "@/lib/i18n";
import { chatSummaryKeys, chatSummaryPath } from "./queries";

export function setChatSummaryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { agentId: string; enabled: boolean }) =>
      client(chatSummaryPath(variables.agentId), {
        method: "PUT",
        body: { enabled: variables.enabled },
        fallback: tNow("The setting could not be saved."),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: chatSummaryKeys.all }),
  });
}
