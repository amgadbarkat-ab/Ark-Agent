import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** Ark Link (#149) as an administrator sees it in Settings → Phones. Never the install token. */
export type ArkLinkDevice = {
  id: string;
  name: string;
  pairedAt: string;
  lastUsedAt: string | null;
};

export type ArkLinkPairing = {
  code: string;
  /** `ABCD-EFGH`. */
  display: string;
  /** The pairing page's address, which the QR code holds. */
  url: string;
  expiresAt: string;
  claims: { pairingId: string; deviceName: string; expiresAt: string }[];
};

export type ArkLinkState = {
  configured: boolean;
  relayUrl: string | null;
  enabled: boolean;
  status: "off" | "connecting" | "connected" | "refused";
  problem: string | null;
  /** This computer has no sign-in: a paired phone acts as its administrator. */
  noSignIn: boolean;
  pairing: ArkLinkPairing | null;
  devices: ArkLinkDevice[];
};

export const arkLinkKeys = {
  all: ["ark-link"] as const,
  state: () => [...arkLinkKeys.all, "state"] as const,
};

export function arkLinkQueryOptions() {
  return queryOptions({
    queryKey: arkLinkKeys.state(),
    queryFn: async (): Promise<ArkLinkState> =>
      (
        await client("/api/ark-link", {
          fallback: "Could not load the phones",
        })
      ).json(),
    // A phone claiming a code shows up here within a couple of seconds.
    refetchInterval: (query) => (query.state.data?.pairing ? 2_000 : 15_000),
  });
}
