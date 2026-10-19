import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { ListingRow } from "@/components/marketplace/listing-row";
import { Separator } from "@/components/ui/separator";
import { publisherQueryOptions } from "@/lib/marketplace/queries";

export const Route = createFileRoute(
  "/_authed/_app/marketplace/publishers/$id",
)({ component: PublisherPage });

function PublisherPage() {
  const { id } = Route.useParams();
  const page = useQuery(publisherQueryOptions(id));
  const back = {
    label: "Digital Team",
    linkProps: { to: "/agents" } as const,
  };

  if (page.isPending) {
    return null;
  }
  if (page.error || !page.data) {
    return (
      <PageShell backButton={back} title="Not found">
        <PageEmpty>That publisher is not here.</PageEmpty>
      </PageShell>
    );
  }
  const { publisher, listings } = page.data;
  return (
    <PageShell
      backButton={back}
      description={
        publisher.bio ||
        (publisher.official
          ? "Digital employees made by the Ark team."
          : undefined)
      }
      title={publisher.displayName}
    >
      <PageSection title="Published">
        {listings.length === 0 ? (
          <PageEmpty>Nothing published yet.</PageEmpty>
        ) : (
          <PageRows>
            {listings.map((listing, index) => (
              <StaggerItem index={index} key={listing.id}>
                <ListingRow listing={listing} />
                {index !== listings.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
