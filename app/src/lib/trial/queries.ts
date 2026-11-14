import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** A customer trial on this install (#109), as the server reads it. */
export type Trial = {
  customerId: string;
  customerName: string;
  status: "trial" | "ended" | "paid";
  startsAt: string;
  endsAt: string;
  lengthDays: number;
  daysLeft: number;
  planId: string;
  planName: string;
  /** Whether making more digital employees is refused right now. */
  createBlocked: boolean;
  rosterSize: number;
  checkInHost: string | null;
  lastCheckInAt: string | null;
  lastCheckInError: string | null;
};

export type TrialOverview = {
  trial: Trial | null;
  /** Whether this version can check a BlackArk signature at all. */
  keyConfigured: boolean;
};

/** What installs reported, on BlackArk's own server. */
export type TrialInstall = {
  installId: string;
  customerId: string;
  version: string;
  status: "trial" | "ended" | "paid";
  daysLeft: number;
  endsAt: string | null;
  employees: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export const trialKeys = {
  all: ["trial"] as const,
  overview: () => [...trialKeys.all, "overview"] as const,
  installs: () => [...trialKeys.all, "installs"] as const,
};

/**
 * The trial, if there is one. Asking also sets up the roster on the server the first time, which is
 * why the app asks once as it opens (see `_authed.tsx`).
 */
export function trialQueryOptions() {
  return queryOptions({
    queryKey: trialKeys.overview(),
    queryFn: async (): Promise<TrialOverview> =>
      (
        await client("/api/trial", { fallback: "Could not load the trial" })
      ).json(),
    staleTime: 60_000,
  });
}

export function trialInstallsQueryOptions() {
  return queryOptions({
    queryKey: trialKeys.installs(),
    queryFn: async (): Promise<{ installs: TrialInstall[]; total: number }> =>
      (
        await client("/api/admin/trials", {
          fallback: "Could not load the trials",
        })
      ).json(),
  });
}
