import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export {
  CATEGORIES,
  LIMITS,
  REPORT_REASONS,
} from "../../../../shared/marketplace";
export type {
  CategoryId,
  ListingKind,
  ListingStatus,
} from "../../../../shared/marketplace";

import type {
  ListingKind,
  ListingStatus,
} from "../../../../shared/marketplace";

export type PublisherSummary = {
  id: string;
  displayName: string;
  official: boolean;
};

export type PublisherProfile = PublisherSummary & { bio: string };

/** One line of the marketplace: enough to choose from, nothing to install from. */
export type ListingCard = {
  id: string;
  slug: string;
  kind: ListingKind;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  publisher: PublisherSummary;
  installCount: number;
  publishedAt: string | null;
  version: number;
};

/** Who one of Ark's digital employees is, what it brings and what it will ask to be connected. */
export type OfficialRole = {
  iam: string;
  duties: string[];
  worksWith: string[];
  supportedBy: string[];
  canDo: string[];
  skills: { slug: string; title: string; summary: string }[];
  connections: { app: string; why: string }[];
  mcpServers: { server: string; why: string }[];
};

export type OfficialContent = {
  install: { name: string; title: string; roleDescription: string };
  suggestedTools: string[];
  /** Absent on a listing written before roles had one. */
  role?: OfficialRole;
};

/** What a shared listing shows. Text only: it has no address and no key, and nothing runs from it. */
export type SharedContent = {
  title: string;
  roleDescription: string;
  instructions?: string;
  tools: string[];
};

/**
 * A listing's own page.
 *
 * `mine`, `status` and `installedByMe` are the server's facts about the viewer. `status` and
 * `reviewNote` arrive only for the person it belongs to and for staff. The screen renders them and
 * never works any of it out.
 */
export type ListingDetail = ListingCard & {
  description: string;
  content: OfficialContent | SharedContent;
  mine: boolean;
  status?: ListingStatus;
  reviewNote?: string | null;
  installedByMe?: boolean;
};

export function isOfficialContent(
  content: OfficialContent | SharedContent,
): content is OfficialContent {
  return "install" in content;
}

export type MyListing = ListingCard & {
  status: ListingStatus;
  reviewNote: string | null;
};

export type MyListings = {
  publisher: PublisherProfile | null;
  listings: MyListing[];
};

export type ListingsPage = {
  listings: ListingCard[];
  nextCursor: string | null;
};

export type BrowseFilter = {
  q: string;
  category: string;
  kind: ListingKind | "";
};

export type ReportRow = {
  id: string;
  reason: string;
  details: string;
  createdAt: string;
  listing: {
    id: string;
    slug: string;
    title: string;
    status: ListingStatus;
    publisherName: string;
  };
};

export const marketplaceKeys = {
  all: ["marketplace"] as const,
  browse: (filter: BrowseFilter) =>
    [...marketplaceKeys.all, "browse", filter] as const,
  listing: (slug: string) => [...marketplaceKeys.all, "listing", slug] as const,
  publisher: (id: string) => [...marketplaceKeys.all, "publisher", id] as const,
  mine: () => [...marketplaceKeys.all, "mine"] as const,
  pending: () => [...marketplaceKeys.all, "pending"] as const,
  reports: () => [...marketplaceKeys.all, "reports"] as const,
};

export function browseQueryOptions(filter: BrowseFilter) {
  return infiniteQueryOptions({
    queryKey: marketplaceKeys.browse(filter),
    initialPageParam: "",
    queryFn: ({ pageParam }): Promise<ListingsPage> => {
      const query = new URLSearchParams();
      if (filter.q.trim()) query.set("q", filter.q.trim());
      if (filter.category) query.set("category", filter.category);
      if (filter.kind) query.set("kind", filter.kind);
      if (pageParam) query.set("cursor", pageParam as string);
      const suffix = query.size > 0 ? `?${query}` : "";
      return client(`/api/marketplace${suffix}`, {
        fallback: "Could not load the marketplace",
      }).then((response) => response.json() as Promise<ListingsPage>);
    },
    getNextPageParam: (page: ListingsPage) => page.nextCursor ?? undefined,
  });
}

export function listingQueryOptions(slug: string) {
  return queryOptions({
    queryKey: marketplaceKeys.listing(slug),
    queryFn: (): Promise<ListingDetail> =>
      client(
        `/api/marketplace/listings/${encodeURIComponent(slug)}`,
        "listing",
        {
          fallback: "Could not load this listing",
        },
      ),
  });
}

export function publisherQueryOptions(id: string) {
  return queryOptions({
    queryKey: marketplaceKeys.publisher(id),
    queryFn: async (): Promise<{
      publisher: PublisherProfile;
      listings: ListingCard[];
    }> =>
      (
        await client(`/api/marketplace/publishers/${encodeURIComponent(id)}`, {
          fallback: "Could not load this publisher",
        })
      ).json(),
  });
}

export function myListingsQueryOptions() {
  return queryOptions({
    queryKey: marketplaceKeys.mine(),
    queryFn: async (): Promise<MyListings> =>
      (
        await client("/api/marketplace/mine", {
          fallback: "Could not load your shared digital employees",
        })
      ).json(),
  });
}

/** Staff: what waits for review, oldest first. */
export function pendingListingsQueryOptions() {
  return infiniteQueryOptions({
    queryKey: marketplaceKeys.pending(),
    initialPageParam: "",
    queryFn: ({
      pageParam,
    }): Promise<{
      listings: ListingDetail[];
      nextCursor: string | null;
    }> =>
      client(
        `/api/admin/marketplace/pending${pageParam ? `?cursor=${encodeURIComponent(pageParam as string)}` : ""}`,
        { fallback: "Could not load the review queue" },
      ).then((response) => response.json()),
    getNextPageParam: (page: { nextCursor: string | null }) =>
      page.nextCursor ?? undefined,
  });
}

/** Staff: open reports, oldest first. */
export function reportsQueryOptions() {
  return infiniteQueryOptions({
    queryKey: marketplaceKeys.reports(),
    initialPageParam: "",
    queryFn: ({
      pageParam,
    }): Promise<{
      reports: ReportRow[];
      nextCursor: string | null;
    }> =>
      client(
        `/api/admin/marketplace/reports${pageParam ? `?cursor=${encodeURIComponent(pageParam as string)}` : ""}`,
        { fallback: "Could not load the reports" },
      ).then((response) => response.json()),
    getNextPageParam: (page: { nextCursor: string | null }) =>
      page.nextCursor ?? undefined,
  });
}
