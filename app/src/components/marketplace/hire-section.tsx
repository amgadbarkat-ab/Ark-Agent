import { IconPlus } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { ListingRow } from "@/components/marketplace/listing-row";
import { ShareDialog } from "@/components/marketplace/share-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
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

const KINDS: { id: BrowseFilter["kind"]; name: string }[] = [
  { id: "official", name: "Made by Ark" },
  { id: "shared", name: "Shared by people" },
];

/**
 * Ready-made digital employees to hire, and ones other people have shared, on the Digital Team page.
 *
 * This is what the Marketplace page was, moved into the one place a person looks after their team. It
 * is a section of that page and not a page of its own, so hiring somebody and seeing them join the
 * team above it are one motion.
 */
export function HireSection() {
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
    <>
      <PageSection
        action={
          <Button onClick={() => setSharing(true)} size="sm" variant="ghost">
            <IconPlus />
            Share one of yours
          </Button>
        }
        description={
          kind === "official"
            ? "Made by Ark. Hire one and it joins your team as a digital employee of yours, with its skills and no tools until you grant them."
            : "Set up by other people. These are for reading: they cannot be hired, copied or exported."
        }
        title="Hire a digital employee"
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
            Shared by you
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input
            aria-label="Search digital employees to hire"
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
            Could not load the digital employees to hire.
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            {q || category
              ? "Nothing matches that."
              : kind === "shared"
                ? "Nobody has shared a digital employee yet."
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

        {kind === "official" && !q && !category ? (
          <PageRows>
            <Item
              render={(props) => (
                <Link search={{ new: true }} to="/agents" {...props} />
              )}
              size="sm"
              variant="muted"
            >
              <ItemMedia variant="icon">
                <IconPlus />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>A role you write yourself</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  Not on the list? Describe the job in your own words and you
                  have a digital employee for it.
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        ) : null}

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
    </>
  );
}
