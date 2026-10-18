import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { memoriesPath, memoryKeys } from "./queries";

const FALLBACK = "That memory could not be saved.";

function refresh(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: memoryKeys.all });
}

export function addMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { agentId: string; content: string }) =>
      client(memoriesPath(variables.agentId), {
        method: "POST",
        body: { content: variables.content },
        fallback: FALLBACK,
      }),
    onSuccess: () => refresh(queryClient),
  });
}

export function updateMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { agentId: string; id: string; content: string }) =>
      client(
        `${memoriesPath(variables.agentId)}/${encodeURIComponent(variables.id)}`,
        {
          method: "PATCH",
          body: { content: variables.content },
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => refresh(queryClient),
  });
}

export function deleteMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { agentId: string; id: string }) =>
      client(
        `${memoriesPath(variables.agentId)}/${encodeURIComponent(variables.id)}`,
        {
          method: "DELETE",
          fallback: "That memory could not be deleted.",
        },
      ),
    onSuccess: () => refresh(queryClient),
  });
}
