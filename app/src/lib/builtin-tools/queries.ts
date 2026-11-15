import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** The business's uploaded price list (#109), as an administrator sees it. */
export type PriceListStatus = {
  fileName: string;
  uploadedAt: string;
  rows: number;
  header: string;
};

/** Whether video editing can run on this computer (#109). */
export type VideoStatus = {
  enabled: boolean;
  ready: boolean;
  problem: string | null;
  ffmpeg: string | null;
  mediaDir: string | null;
};

export const builtinToolKeys = {
  all: ["builtin-tools"] as const,
  priceList: () => [...builtinToolKeys.all, "price-list"] as const,
  video: () => [...builtinToolKeys.all, "video"] as const,
};

export function priceListQueryOptions() {
  return queryOptions({
    queryKey: builtinToolKeys.priceList(),
    queryFn: (): Promise<PriceListStatus | null> =>
      client("/api/price-list", "list", {
        fallback: "Could not load the price list",
      }),
  });
}

export function videoStatusQueryOptions() {
  return queryOptions({
    queryKey: builtinToolKeys.video(),
    queryFn: async (): Promise<VideoStatus> =>
      (
        await client("/api/video/status", {
          fallback: "Could not check video editing",
        })
      ).json(),
  });
}
