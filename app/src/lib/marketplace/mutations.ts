import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client, tryClient } from "@/lib/client";
import { type ListingDetail, marketplaceKeys } from "./queries";

const FALLBACK = "Could not save the listing";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: marketplaceKeys.all });
}

/** What was found in a listing and where. Never the text itself. */
export type Finding = {
  kind: string;
  field: string;
  line: number;
  message: string;
  /** A secret can never be published. Anything else the publisher may confirm is safe. */
  secret: boolean;
};

export type ListingInput = {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  description: string;
  /** The publisher read it through and says it holds nothing private. */
  confirmedNoPrivateData: boolean;
};

/**
 * Sharing, editing: the server either accepts the listing or says what to fix.
 *
 * A refusal over a secret or private detail is an answer rather than a failure, with the findings
 * to show, so it comes back as a value. Anything else that goes wrong throws.
 */
export type SubmitResult =
  | { ok: true; listing: ListingDetail }
  | { ok: false; error: string; findings: Finding[] };

async function submit(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<SubmitResult> {
  const response = await tryClient(path, { method, body });
  if (response.ok) {
    return { ok: true, listing: (await response.json()).listing };
  }
  const refusal = (await response.json().catch(() => ({}))) as {
    error?: string;
    findings?: Finding[];
  };
  if (response.status === 422) {
    return {
      ok: false,
      error: refusal.error ?? "This cannot be shared yet.",
      findings: refusal.findings ?? [],
    };
  }
  throw new Error(refusal.error ?? FALLBACK);
}

export function shareCoworkerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: ListingInput & { agentId: string }) =>
      submit("/api/marketplace/mine/listings", "POST", variables),
    onSuccess: () => invalidate(queryClient),
  });
}

export function updateListingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; input: ListingInput }) =>
      submit(
        `/api/marketplace/mine/listings/${variables.id}`,
        "PUT",
        variables.input,
      ),
    onSuccess: () => invalidate(queryClient),
  });
}

export function withdrawListingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/marketplace/mine/listings/${id}`, {
        method: "DELETE",
        fallback: "Could not withdraw the listing",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function savePublisherMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      displayName: string;
      bio: string;
    }): Promise<void> => {
      await client("/api/marketplace/mine/publisher", {
        method: "PUT",
        body: variables,
        fallback: "Could not save the name",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

/** Put one of Ark's own digital employees into the person's account. */
export function installListingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      slug: string,
    ): Promise<{ agentId: string; name: string }> =>
      (
        await client(
          `/api/marketplace/listings/${encodeURIComponent(slug)}/install`,
          {
            method: "POST",
            fallback: "Could not install this digital employee",
          },
        )
      ).json(),
    onSuccess: async () => {
      // A new coworker, and a new install count.
      await Promise.all([
        invalidate(queryClient),
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
      ]);
    },
  });
}

export function reportListingMutationOptions() {
  return mutationOptions({
    mutationFn: async (variables: {
      slug: string;
      reason: string;
      details: string;
    }): Promise<void> => {
      await client(
        `/api/marketplace/listings/${encodeURIComponent(variables.slug)}/report`,
        {
          method: "POST",
          body: { reason: variables.reason, details: variables.details },
          fallback: "Could not send the report",
        },
      );
    },
  });
}

/** Staff. */
export function reviewListingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      id: string;
      decision: "approve" | "reject" | "remove";
      note?: string;
    }): Promise<void> => {
      await client(
        `/api/admin/marketplace/listings/${variables.id}/${variables.decision}`,
        {
          method: "POST",
          ...(variables.decision === "approve"
            ? {}
            : { body: { note: variables.note ?? "" } }),
          fallback: "Could not save the decision",
        },
      );
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function dismissReportMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/admin/marketplace/reports/${id}/dismiss`, {
        method: "POST",
        fallback: "Could not dismiss the report",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}
