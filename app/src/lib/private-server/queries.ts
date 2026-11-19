import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One Ark Private Server tier (#149), as BlackArk sells it. Prices in euro cents, excluding VAT. */
export type ServerTier = {
  id: string;
  name: string;
  cpu: string | null;
  memory: string;
  gpu: string | null;
  storage: string;
  modelSize: string;
  models: string[];
  monthlyCents: number;
  activationCents: number;
};

export type ServerOrderStatus =
  | "setting_up"
  | "ready"
  | "stopped"
  | "cancelled";

/** This customer's latest order. Never a key. */
export type ServerOrder = {
  tier: string;
  status: ServerOrderStatus;
  orderedAt: string;
  paidUntil: string | null;
  readyAt: string | null;
  baseUrl: string | null;
  model: string | null;
};

export type PrivateServerState = {
  available: boolean;
  tiers: ServerTier[];
  order: ServerOrder | null;
  buyUrl: string | null;
  connected: boolean;
  error: string | null;
};

export const privateServerKeys = {
  all: ["private-server"] as const,
};

/** The tiers, BlackArk's buy page and this customer's order, for an administrator. */
export function privateServerQueryOptions() {
  return queryOptions({
    queryKey: privateServerKeys.all,
    queryFn: async (): Promise<PrivateServerState> =>
      (
        await client("/api/private-server", {
          fallback: "Could not load Ark Private Server",
        })
      ).json(),
    // An order being set up is watched, so "ready" shows without a reload.
    refetchInterval: (query) =>
      query.state.data?.order?.status === "setting_up" ? 60_000 : false,
  });
}
