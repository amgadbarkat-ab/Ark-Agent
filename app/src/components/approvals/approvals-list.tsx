import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { decideApprovalMutationOptions } from "@/lib/approvals/mutations";
import {
  type ApprovalRecord,
  approvalsQueryOptions,
} from "@/lib/approvals/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

const STATUS_WORDS: Record<ApprovalRecord["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  failed: "Approved, but it could not be applied",
};

/**
 * What the person's digital employees have asked to change, and the two answers.
 *
 * A request says who asked, what it would change and for whom, in the sentence the server wrote from
 * the change itself. Nothing is applied until Approve is pressed, and a request nobody answers lapses
 * on its own, so an unread inbox never changes anything.
 */
export function ApprovalsList() {
  const [showAll, setShowAll] = useState(false);
  const approvals = useQuery(
    approvalsQueryOptions(showAll ? "all" : "pending"),
  );
  const decide = useMutation(decideApprovalMutationOptions(queryClient));
  const rows = approvals.data?.approvals ?? [];

  return (
    <PageSection>
      {decide.error ? (
        <p className="mb-2 text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}

      {approvals.isPending ? null : approvals.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Your requests could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <Empty className="h-[180px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              Nothing is waiting for you
            </EmptyTitle>
            <EmptyDescription>
              When your lead digital employee wants to change a colleague's
              routine or instructions, it asks here first.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <Item key={row.id} variant="muted">
              <ItemContent>
                <ItemTitle>
                  {row.requestedBy.name ?? "A digital employee"}
                  {row.target?.name ? ` · for ${row.target.name}` : ""}
                </ItemTitle>
                <ItemDescription className="line-clamp-none whitespace-pre-wrap">
                  {row.summary}
                </ItemDescription>
                <ItemDescription className="text-xs">
                  {STATUS_WORDS[row.status]}
                  {row.status === "pending"
                    ? ` · asked ${relativeTime(row.createdAt)}`
                    : row.decidedAt
                      ? ` · ${relativeTime(row.decidedAt)}`
                      : ""}
                  {row.result && row.status !== "pending"
                    ? ` · ${row.result}`
                    : ""}
                </ItemDescription>
              </ItemContent>
              {row.status === "pending" ? (
                <ItemActions>
                  <Button
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: row.id, decision: "reject" })
                    }
                    size="sm"
                    variant="ghost"
                  >
                    Reject
                  </Button>
                  <Button
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ id: row.id, decision: "approve" })
                    }
                    size="sm"
                  >
                    Approve
                  </Button>
                </ItemActions>
              ) : null}
            </Item>
          ))}
        </div>
      )}

      <div className="mt-3">
        <Button
          onClick={() => setShowAll((value) => !value)}
          size="sm"
          variant="ghost"
        >
          {showAll ? "Show only what is waiting" : "Show earlier requests"}
        </Button>
      </div>
    </PageSection>
  );
}
