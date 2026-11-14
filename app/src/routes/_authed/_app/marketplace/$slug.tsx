import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { ListingView } from "@/components/marketplace/listing-view";
import { tNow, useT } from "@/lib/i18n";
import { listingQueryOptions } from "@/lib/marketplace/queries";

export const Route = createFileRoute("/_authed/_app/marketplace/$slug")({
  component: ListingPage,
});

function ListingPage() {
  const t = useT();
  const { slug } = Route.useParams();
  const listing = useQuery(listingQueryOptions(slug));

  const back = {
    label: tNow("Digital Team"),
    linkProps: { to: "/agents" } as const,
  };

  if (listing.isPending) return null;
  if (listing.error || !listing.data) {
    return (
      <PageShell backButton={back} title={t("Not found")}>
        <PageEmpty>
          {t("That listing is not here, or is not public yet.")}
        </PageEmpty>
      </PageShell>
    );
  }
  return <ListingView backButton={back} listing={listing.data} />;
}
