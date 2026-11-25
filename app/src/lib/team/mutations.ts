import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { teamKeys } from "./queries";

/** Who has an employee the administrator asked for, so they can confirm moving it. */
export type TeamConflict = {
  agentId: string;
  fromUserId: string;
  fromName: string;
};

/** The server's answer, or its refusal with the conflicts to confirm. */
export class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly conflicts: TeamConflict[] = [],
  ) {
    super(message);
  }
}

async function send(path: string, method: string, body?: unknown) {
  const response = await tryClient(path, {
    method: method as "POST",
    ...(body === undefined ? {} : { body }),
  });
  const answer = (await response.json().catch(() => ({}))) as {
    error?: string;
    detail?: { conflicts?: TeamConflict[] };
    checkoutUrl?: string | null;
  };
  if (!response.ok)
    throw new TeamRequestError(
      answer.error ?? "That did not work. Try again.",
      answer.detail?.conflicts ?? [],
    );
  return answer;
}

function refresh(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: teamKeys.all });
}

export function addSubprofileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      name: string;
      email: string;
      password: string;
      agentIds: string[];
      move?: boolean;
    }) => send("/api/team/members", "POST", input),
    onSuccess: () => refresh(queryClient),
  });
}

export function setSubprofileAgentsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: {
      userId: string;
      agentIds: string[];
      move?: boolean;
    }) =>
      send(
        `/api/team/members/${encodeURIComponent(input.userId)}/agents`,
        "PUT",
        { agentIds: input.agentIds, move: input.move === true },
      ),
    onSuccess: () => refresh(queryClient),
  });
}

export function removeSubprofileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (userId: string) =>
      send(`/api/team/members/${encodeURIComponent(userId)}`, "DELETE"),
    onSuccess: () => refresh(queryClient),
  });
}

export function changePasswordMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { current: string; next: string }) =>
      send("/api/team/me/password", "POST", input),
    onSuccess: () => refresh(queryClient),
  });
}
