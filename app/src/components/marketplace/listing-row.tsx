import { IconBook, IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import type { ListingCard } from "@/lib/marketplace/queries";

/**
 * One listing in a list. The whole row opens its page.
 *
 * An official listing says it is Ark's; a shared one says whose it is, because a stranger's work
 * should never look like ours.
 */
export function ListingRow({
  listing,
  note,
}: {
  listing: ListingCard;
  /** Extra words after the publisher, such as a status on a person's own list. */
  note?: string;
}) {
  const by = listing.publisher.official
    ? "Ark"
    : `Shared by ${listing.publisher.displayName}`;
  return (
    <Item
      render={<Link params={{ slug: listing.slug }} to="/marketplace/$slug" />}
      size="sm"
    >
      <ItemMedia variant="icon">
        {listing.kind === "official" ? <IconSparkles /> : <IconBook />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{listing.title}</ItemTitle>
        <ItemDescription>{listing.summary}</ItemDescription>
        <ItemDescription className="line-clamp-none">
          {[by, note].filter(Boolean).join(" · ")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
