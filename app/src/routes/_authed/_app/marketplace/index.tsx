import { IconPlus } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ListingRow } from "@/components/marketplace/listing-row";
import { ShareDialog } from "@/components/marketplace/share-dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  type BrowseFilter,
  browseQueryOptions,
  CATEGORIES,
} from "@/lib/marketplace/queries";

export const Route = createFileRoute("/_authed/_app/marketplace/")({
  component: MarketplacePage,
});

const KINDS: { id: BrowseFilter["kind"]; name: string }[] = [
  { id: "official", name: "Ark's digital employees" },
  { id: "shared", name: "Shared by people" },
];

function MarketplacePage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState<BrowseFilter["kind"]>("official");
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const listings = useInfiniteQuery(browseQueryOptions({ q, category, kind }));
  const rows = listings.data?.pages.flatMap((page) => page.listings) ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setSharing(true)} size="sm" variant="ghost">
          <IconPlus />
          Share a coworker
        </Button>
      }
      description="Digital employees you can hire into your own account, and coworkers other people have shared as guides to read."
      title="Marketplace"
    >
      <PageSection
        description={
          kind === "official"
            ? "Made by Ark. Install one and it becomes a coworker of yours, with no tools until you grant them."
            : "Set up by other people. These are for reading: they cannot be installed, copied or exported."
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {KINDS.map((option) => (
            <Button
              aria-pressed={kind === option.id}
              key={option.id}
              onClick={() => setKind(option.id)}
              size="sm"
              variant={kind === option.id ? "secondary" : "ghost"}
            >
              {option.name}
            </Button>
          ))}
          <Button
            render={(props) => <Link to="/marketplace/mine" {...props} />}
            size="sm"
            variant="ghost"
          >
            Yours
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            aria-label="Search the marketplace"
            className="min-w-48 flex-1"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            value={search}
          />
          <Select
            onValueChange={(value) =>
              setCategory(value === "all" ? "" : String(value))
            }
            value={category || "all"}
          >
            <SelectTrigger aria-label="Category" className="w-44">
              <SelectValue>
                {category
                  ? CATEGORIES.find((c) => c.id === category)?.name
                  : "All categories"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {listings.isPending ? null : listings.error && rows.length === 0 ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load the marketplace.
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            {q || category
              ? "Nothing matches that."
              : kind === "shared"
                ? "Nobody has shared a coworker yet."
                : "Nothing is listed yet."}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((listing, index) => (
              <StaggerItem index={index} key={listing.id}>
                <ListingRow listing={listing} />
                {index !== rows.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}

        {listings.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={listings.isFetchingNextPage}
            onClick={() => listings.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {listings.isFetchingNextPage ? "Loading…" : "Show more"}
          </Button>
        ) : null}
      </PageSection>
      <ShareDialog onOpenChange={setSharing} open={sharing} />
    </PageShell>
  );
}
