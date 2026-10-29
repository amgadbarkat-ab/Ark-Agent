import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
  rejected: "Declined",
  expired: "Expired",
  failed: "Approved, but it could not be carried out",
};

/** What kind of thing is waiting, in the words a person scans the list by. */
function kindWords(kind: string): string {
  if (kind === "tool.call") return "Wants to use a tool";
  if (kind === "computer.action") return "Wants to act in its browser";
  if (kind === "chat.card") return "Asked you in a conversation";
  return "Wants to change a colleague's work";
}

/**
 * Everything that is waiting for the person, in one place, and the two answers.
 *
 * A lead's request to change a colleague's work, a tool call or browser action held for approval,
 * and an approval card raised in a conversation all arrive here, so the list never says "Nothing is
 * waiting for you" while a card waits in a chat (desk #69). Each says who asked and what will
 * happen, with the exact arguments where there are some. Nothing runs until Approve is pressed, and
 * a request nobody answers lapses on its own, so an unread list never does anything.
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
              When a digital employee needs your approval — to send, pay, delete
              or change something, or to change a colleague's work — it asks
              here first.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul aria-label="Requests" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Item variant="muted">
                <ItemContent>
                  <ItemTitle>
                    {row.requestedBy.name ?? "A digital employee"}
                    {row.target?.name ? ` · for ${row.target.name}` : ""}
                  </ItemTitle>
                  <ItemDescription className="text-xs">
                    {kindWords(row.kind)}
                  </ItemDescription>
                  <ItemDescription className="line-clamp-none whitespace-pre-wrap">
                    {row.summary}
                  </ItemDescription>
                  {row.details?.length ? (
                    <dl className="mt-1 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1 text-sm">
                      {row.details.map((detail, index) => (
                        <div
                          className="contents"
                          key={`${detail.label}-${index.toString()}`}
                        >
                          <dt className="truncate text-muted-foreground">
                            {detail.label}
                          </dt>
                          <dd className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-5">
                            {detail.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
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
                    {row.channelId ? (
                      <>
                        {" · "}
                        <Link
                          className="underline underline-offset-2"
                          params={{ channelId: row.channelId }}
                          to="/channel/$channelId"
                        >
                          Open the conversation
                        </Link>
                      </>
                    ) : null}
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
                      Decline
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
            </li>
          ))}
        </ul>
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
