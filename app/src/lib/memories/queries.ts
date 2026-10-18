import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One thing a digital employee keeps in mind, as its Memories page shows it. */
export type MemoryRecord = {
  id: string;
  content: string;
  /** Who put it there: the employee itself, its owner, or a change the owner approved. */
  source: "agent" | "person" | "approved";
  createdAt: string;
  updatedAt: string;
};

export const memoryKeys = {
  all: ["memories"] as const,
  list: (agentId: string) => ["memories", "list", agentId] as const,
};

export const memoriesPath = (agentId: string) =>
  `/api/agents/${encodeURIComponent(agentId)}/memories`;

export function memoriesQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: memoryKeys.list(agentId),
    queryFn: async (): Promise<MemoryRecord[]> => {
      const response = await client(memoriesPath(agentId), {
        fallback: "Its memories could not be loaded.",
      });
      const body = (await response.json()) as { memories?: MemoryRecord[] };
      return body.memories ?? [];
    },
  });
}
