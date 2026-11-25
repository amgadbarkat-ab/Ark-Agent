import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * A customer's team (Amgad, 24 Nov 2026): the administrator and the staff sub-profiles, EUR 15 a month
 * each, who sign in as themselves and use the digital employees the administrator gives them.
 */
export type TeamMe = {
  role: "admin" | "subprofile";
  status: "pending_payment" | "active" | "suspended" | "removed";
  mustChangePassword: boolean;
};

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: "admin" | "subprofile";
  status: "pending_payment" | "active" | "suspended" | "removed";
  createdAt: string;
  mustChangePassword: boolean;
  agentIds: string[];
};

export const teamKeys = {
  all: ["team"] as const,
  me: ["team", "me"] as const,
  members: ["team", "members"] as const,
};

/** This person's place on the team, or null where the deployment has no team (one person, no sign-in). */
export function teamMeQueryOptions() {
  return queryOptions({
    queryKey: teamKeys.me,
    queryFn: async (): Promise<TeamMe | null> => {
      const response = await tryClient("/api/team/me").catch(() => null);
      if (response?.status !== 200) return null;
      return (await response.json()) as TeamMe;
    },
  });
}

/** Everybody on the team, for the administrator. Watched while somebody waits for payment. */
export function teamMembersQueryOptions() {
  return queryOptions({
    queryKey: teamKeys.members,
    queryFn: async (): Promise<TeamMember[]> => {
      const response = await client("/api/team", {
        fallback: "The team could not be loaded.",
      });
      return ((await response.json()) as { members: TeamMember[] }).members;
    },
    refetchInterval: (query) =>
      query.state.data?.some((one) => one.status === "pending_payment")
        ? 60_000
        : false,
  });
}
