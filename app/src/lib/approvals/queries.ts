import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * A change one digital employee asked to make to another's work, as the inbox shows it.
 *
 * The summary is the whole of what will change, in words, and is written by the server from the
 * change itself. The payload is never sent to the browser.
 */
export type ApprovalRecord = {
  id: string;
  kind: string;
  summary: string;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  result: string | null;
  requestedBy: { id: string; name: string | null };
  target: { id: string; name: string | null } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};

export type ApprovalsPage = { approvals: ApprovalRecord[]; pending: number };

export const approvalKeys = {
  all: ["approvals"] as const,
  list: (which: "pending" | "all") => ["approvals", "list", which] as const,
  count: () => ["approvals", "count"] as const,
};

export function approvalsQueryOptions(which: "pending" | "all" = "pending") {
  return queryOptions({
    queryKey: approvalKeys.list(which),
    queryFn: async (): Promise<ApprovalsPage> => {
      const response = await client(`/api/approvals?which=${which}`, {
        fallback: "Your requests could not be loaded.",
      });
      const body = (await response.json()) as Partial<ApprovalsPage>;
      return { approvals: body.approvals ?? [], pending: body.pending ?? 0 };
    },
  });
}

/** How many are waiting, for the number beside the inbox in the sidebar. Cheap, and quiet on failure. */
export function approvalCountQueryOptions() {
  return queryOptions({
    queryKey: approvalKeys.count(),
    queryFn: async (): Promise<number> => {
      const response = await client("/api/approvals/count", {
        fallback: "Could not count your requests.",
      });
      const body = (await response.json()) as { pending?: number };
      return body.pending ?? 0;
    },
    refetchInterval: 60_000,
    retry: false,
  });
}
