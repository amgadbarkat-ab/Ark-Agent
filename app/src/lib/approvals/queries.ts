import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * Something that waits for the person, as their "Needs you" list shows it.
 *
 * Four kinds arrive here: a lead asking to change a colleague's work, a tool call held because the
 * tool asks a person first, a browser action a boundary rule holds, and an approval card an employee
 * raised in a conversation. The summary says what will happen, in words the server wrote; `details`
 * are drawn by the server from the request — for a held call its exact arguments, because what the
 * person approves is what runs. The payload itself is never sent to the browser.
 */
export type ApprovalRecord = {
  id: string;
  /** `routine.update`, `tool.call`, `computer.action`, `chat.card`, … */
  kind: string;
  summary: string;
  details?: { label: string; value: string }[];
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  result: string | null;
  requestedBy: { id: string; name: string | null };
  target: { id: string; name: string | null } | null;
  /** The conversation it was asked in, when there is one to go back to. */
  channelId?: string | null;
  /** For an approval card, the tool call it belongs to. */
  toolCallId?: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};

export type ApprovalsPage = { approvals: ApprovalRecord[]; pending: number };

export const approvalKeys = {
  all: ["approvals"] as const,
  list: (which: "pending" | "all") => ["approvals", "list", which] as const,
  count: () => ["approvals", "count"] as const,
  one: (id: string) => ["approvals", "one", id] as const,
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
    // Held calls and chat cards arrive while the page is open; a list that only refreshed on a
    // decision would say "nothing is waiting" with something waiting (desk #69).
    refetchInterval: 15_000,
  });
}

/**
 * How many are waiting, for the "Needs you" count beside Requests in the sidebar. Cheap, and quiet
 * on failure.
 */
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
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * One request, watched by the approval card it belongs to, so a decision taken in Requests reaches
 * the card while it is on screen. Stops asking once it is decided.
 */
export function approvalQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: approvalKeys.one(id ?? ""),
    enabled: Boolean(id),
    queryFn: async (): Promise<ApprovalRecord | null> => {
      const response = await client(
        `/api/approvals/${encodeURIComponent(id ?? "")}`,
        { fallback: "That request could not be loaded." },
      );
      const body = (await response.json()) as { approval?: ApprovalRecord };
      return body.approval ?? null;
    },
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== "pending" ? false : 3_000,
    // Including from a tab in the background: the usual way a card is decided from Requests is in
    // another tab, and the run the card holds is waiting for exactly that.
    refetchIntervalInBackground: true,
    retry: false,
  });
}
