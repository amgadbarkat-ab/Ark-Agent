import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type BusinessFile = {
  name: string;
  fileName: string;
  uploadedAt: string;
  rows: number;
  header: string;
};

export const businessFileKeys = {
  all: ["business-files"] as const,
};

export function businessFilesQueryOptions() {
  return queryOptions({
    queryKey: businessFileKeys.all,
    queryFn: async (): Promise<{
      files: BusinessFile[];
      folder: string | null;
    }> =>
      (await (
        await client("/api/business-files", {
          fallback: "Could not load the data files",
        })
      ).json()) as { files: BusinessFile[]; folder: string | null },
  });
}
