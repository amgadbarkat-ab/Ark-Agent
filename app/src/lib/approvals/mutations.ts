import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { approvalKeys } from "./queries";

/** Approve or reject one request. The server applies the change on approval and never before. */
export function decideApprovalMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; decision: "approve" | "reject" }) =>
      client(
        `/api/approvals/${encodeURIComponent(variables.id)}/${variables.decision}`,
        {
          method: "POST",
          fallback: "That request could not be decided.",
        },
      ),
    // Refetched either way: a request somebody else already decided should leave the list too.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
  });
}
