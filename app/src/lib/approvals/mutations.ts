import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ApprovalRecord, approvalKeys } from "./queries";

/**
 * Approve or reject one request. The server carries it out on approval and never before.
 *
 * Refetched either way: a request somebody else already decided should leave the list too, and the
 * "Needs you" count and any card watching this request move with it.
 */
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
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
  });
}

/**
 * Put an approval card raised in a conversation into the person's "Needs you" list.
 *
 * Idempotent on the card's tool call: a card drawn again after a reload gets its existing request
 * back, decided or not, which is how it learns it was answered from the list.
 */
export function registerApprovalCardMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (card: {
      toolCallId: string;
      agentId: string;
      channelId?: string;
      title: string;
      summary?: string;
      details?: { label: string; value: string }[];
    }): Promise<ApprovalRecord | null> => {
      const response = await client("/api/approvals/cards", {
        method: "POST",
        body: card,
        fallback: "This request could not be added to Requests.",
      });
      const body = (await response.json()) as { approval?: ApprovalRecord };
      return body.approval ?? null;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
  });
}
