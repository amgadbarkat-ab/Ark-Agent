import { IconBook, IconFlag } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  dismissReportMutationOptions,
  reviewListingMutationOptions,
} from "@/lib/marketplace/mutations";
import {
  isOfficialContent,
  type ListingDetail,
  pendingListingsQueryOptions,
  REPORT_REASONS,
  type ReportRow,
  reportsQueryOptions,
} from "@/lib/marketplace/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/marketplace")({
  component: MarketplaceReview,
});

function MarketplaceReview() {
  const pending = useInfiniteQuery(pendingListingsQueryOptions());
  const reports = useInfiniteQuery(reportsQueryOptions());
  const waiting = pending.data?.pages.flatMap((page) => page.listings) ?? [];
  const open = reports.data?.pages.flatMap((page) => page.reports) ?? [];

  return (
    <PageShell
      description="Shared digital employees are read here before anyone else can see them, and reported ones are decided here."
      title="Marketplace"
    >
      <PageSection
        description="Oldest first. Look at what a stranger would read: the role, the instruction and the tool names. Reject anything with a secret, private data or somebody else's work, and say why. The publisher is shown the reason."
        title="Waiting for review"
      >
        {pending.isPending ? null : pending.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load the review queue.
          </p>
        ) : waiting.length === 0 ? (
          <PageEmpty>Nothing is waiting.</PageEmpty>
        ) : (
          <PageRows>
            {waiting.map((listing, index) => (
              <StaggerItem index={index} key={listing.id}>
                <PendingRow listing={listing} />
                {index !== waiting.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
        {pending.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={pending.isFetchingNextPage}
            onClick={() => pending.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {pending.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
      </PageSection>

      <PageSection
        description="Taking a listing down settles every report about it. Dismiss a report that is not a problem."
        title="Reports"
      >
        {reports.isPending ? null : reports.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load the reports.
          </p>
        ) : open.length === 0 ? (
          <PageEmpty>No open reports.</PageEmpty>
        ) : (
          <PageRows>
            {open.map((report, index) => (
              <StaggerItem index={index} key={report.id}>
                <ReportItem report={report} />
                {index !== open.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
        {reports.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={reports.isFetchingNextPage}
            onClick={() => reports.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {reports.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}

/** What a stranger would read, on one line each, so the reviewer sees the same thing. */
function PendingRow({ listing }: { listing: ListingDetail }) {
  const review = useMutation(reviewListingMutationOptions(queryClient));
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const content = listing.content;
  const shared = isOfficialContent(content) ? null : content;

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconBook />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{listing.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {listing.summary} · by {listing.publisher.displayName} · version{" "}
          {listing.version}
        </ItemDescription>
        {shared ? (
          <ItemDescription className="mt-1 line-clamp-none whitespace-pre-wrap">
            Role: {shared.roleDescription}
            {shared.instructions
              ? `\n\nInstruction: ${shared.instructions}`
              : ""}
            {`\n\nTools: ${shared.tools.length > 0 ? shared.tools.join(", ") : "none"}`}
            {listing.description
              ? `\n\nDescription: ${listing.description}`
              : ""}
          </ItemDescription>
        ) : null}
        {rejecting ? (
          <Input
            aria-label={`Reason for rejecting ${listing.title}`}
            autoFocus
            className="mt-2"
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why? The publisher is shown this."
            value={note}
          />
        ) : null}
        {review.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {review.error.message}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {rejecting ? (
          <>
            <Button
              onClick={() => setRejecting(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={review.isPending || !note.trim()}
              onClick={() =>
                review.mutate({
                  id: listing.id,
                  decision: "reject",
                  note: note.trim(),
                })
              }
              size="sm"
              variant="destructive"
            >
              Reject
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={review.isPending}
              onClick={() => setRejecting(true)}
              size="sm"
              variant="outline"
            >
              Reject
            </Button>
            <Button
              disabled={review.isPending}
              onClick={() =>
                review.mutate({ id: listing.id, decision: "approve" })
              }
              size="sm"
            >
              {review.isPending ? "Saving…" : "Approve"}
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
  );
}

function ReportItem({ report }: { report: ReportRow }) {
  const dismiss = useMutation(dismissReportMutationOptions(queryClient));
  const remove = useMutation(reviewListingMutationOptions(queryClient));
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState("");
  const reason =
    REPORT_REASONS.find((r) => r.id === report.reason)?.name ?? report.reason;
  const failure = (dismiss.error ?? remove.error)?.message;

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconFlag />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{report.listing.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {reason} · by {report.listing.publisherName}
          {report.details ? ` · "${report.details}"` : ""}
        </ItemDescription>
        <ItemDescription className="line-clamp-none">
          <Link
            className="underline underline-offset-2"
            params={{ slug: report.listing.slug }}
            to="/marketplace/$slug"
          >
            Read the listing
          </Link>
        </ItemDescription>
        {removing ? (
          <Input
            aria-label={`Reason for taking down ${report.listing.title}`}
            autoFocus
            className="mt-2"
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why? The publisher is shown this."
            value={note}
          />
        ) : null}
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {removing ? (
          <>
            <Button
              onClick={() => setRemoving(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending || !note.trim()}
              onClick={() =>
                remove.mutate({
                  id: report.listing.id,
                  decision: "remove",
                  note: note.trim(),
                })
              }
              size="sm"
              variant="destructive"
            >
              Take down
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(report.id)}
              size="sm"
              variant="outline"
            >
              Dismiss
            </Button>
            <Button
              onClick={() => setRemoving(true)}
              size="sm"
              variant="outline"
            >
              Take down
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
  );
}
