import { useT } from "@/lib/i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { decideApprovalMutationOptions } from "@/lib/approvals/mutations";
import {
  type ApprovalRecord,
  approvalsQueryOptions,
} from "@/lib/approvals/queries";
import { queryClient } from "@/query-client";
import { ApprovalItem } from "./approvals-list";

/**
 * What this conversation's employee is waiting on, shown in the conversation itself.
 *
 * DT Lab, v0.1.32 (#83): a Gmail send was held for approval, the employee said "approve it in
 * Requests", and nothing in the chat could be pressed. A held tool call or browser action is a row
 * in Requests, not a card the employee drew, so the chat never showed it. This shows every request
 * asked in this conversation that is still waiting, with the same two answers as Requests, above the
 * message box. Approval cards an employee raised (`chat.card`) are left out: they are already in the
 * transcript, with their own buttons.
 */
export function waitingHere(
  rows: readonly ApprovalRecord[],
  channelId: string,
): ApprovalRecord[] {
  return rows.filter(
    (row) =>
      row.status === "pending" &&
      row.channelId === channelId &&
      row.kind !== "chat.card",
  );
}

export function ConversationRequests({ channelId }: { channelId: string }) {
  const approvals = useQuery(approvalsQueryOptions("pending"));
  const decide = useMutation(decideApprovalMutationOptions(queryClient));
  const t = useT();
  const rows = waitingHere(approvals.data?.approvals ?? [], channelId);
  if (rows.length === 0) return null;

  return (
    <section aria-label={t("requests.here")} className="pb-2">
      {decide.error ? (
        <p className="mb-2 text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <ApprovalItem
              deciding={decide.isPending}
              linkToConversation={false}
              onDecide={(decision) => decide.mutate({ id: row.id, decision })}
              row={row}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
