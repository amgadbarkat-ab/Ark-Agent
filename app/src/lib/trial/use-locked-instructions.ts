import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/query-client";
import { trialQueryOptions } from "./queries";

/**
 * Whether this digital employee's role and standing instruction come from the signed trial profile
 * and are read-only here (#116), and if so its key in the profile, which is how BlackArk knows it.
 * Null for every other employee, and wherever there is no trial.
 *
 * The server decides and refuses a change anyway; this is so the screen shows the text as read-only
 * and offers "Propose a change" instead of an edit that would only be refused.
 */
export function useLockedInstructions(
  agentId: string,
): { key: string; appVersion: string } | null {
  // The app's one client, named, as in `useCreateBlocked`.
  const { data } = useQuery(trialQueryOptions(), queryClient);
  const locked = data?.lockedEmployees?.find((row) => row.agentId === agentId);
  return locked
    ? { key: locked.key, appVersion: data?.appVersion ?? "unknown" }
    : null;
}
