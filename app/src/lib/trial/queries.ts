import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

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
  /**
   * The trial profile's employees whose role and standing instruction are read-only now (#116), with
   * their key in the profile. The server's verdict: it refuses a change to them anyway. Absent from a
   * server that predates it.
   */
  lockedEmployees?: { key: string; agentId: string }[];
  /** The release the server is, for the "Propose a change" file (#116). */
  appVersion?: string | null;
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

/** Whether this install is activated (#109, v0.1.42), as the server decides it. */
export type Activation = {
  required: boolean;
  /** Whether it may be used now: activated, or not required. */
  allowed: boolean;
  state: "none" | "trial" | "paid" | "ended" | "expired";
  source: "license" | "trial-code" | "trial-profile" | null;
  customerId: string | null;
  customerName: string | null;
  planId: string | null;
  planName: string | null;
  until: string | null;
  daysLeft: number | null;
  seats: number | null;
  /** Ark Team's tier (v0.1.49): digital employees per seat. Null for other plans. */
  agentsPerSeat?: number | null;
  /** How many digital employees this install may have. Null: no limit. */
  agentLimit?: number | null;
  addons: string[];
  renewHost: string | null;
  lastRenewAt: string | null;
  lastRenewError: string | null;
  keys: { trial: boolean; license: boolean };
};

/**
 * Ark Team's agent limit on this install (v0.1.49), as the server counts it. `notice` is the sentence
 * shown once it is full, as an English template the shared Greek table translates.
 */
export type AgentAllowance = {
  limit: number | null;
  inUse: number;
  canAdd: boolean;
  agentsPerSeat: number | null;
  seats: number | null;
  notice: {
    en: string;
    el: string;
    template: string;
    values: Record<string, string | number>;
  } | null;
};

/**
 * The allowance, or null where the server does not say (an older server, a hosted one). Not kept
 * long: making or removing an employee changes it, and every add button asks again when it shows.
 */
export function agentAllowanceQueryOptions() {
  return queryOptions({
    queryKey: [...trialKeys.all, "agents"] as const,
    queryFn: async (): Promise<AgentAllowance | null> => {
      const response = await tryClient("/api/activation");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Could not check the activation");
      return (
        ((await response.json()) as { agents?: AgentAllowance }).agents ?? null
      );
    },
    staleTime: 0,
  });
}

/**
 * Activation, or null where the server has no such route (an older server, or a deployment with no
 * trial service): null means nothing to gate.
 */
export function activationQueryOptions() {
  return queryOptions({
    queryKey: [...trialKeys.all, "activation"] as const,
    queryFn: async (): Promise<Activation | null> => {
      const response = await tryClient("/api/activation");
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Could not check the activation");
      return ((await response.json()) as { activation: Activation }).activation;
    },
    staleTime: 60_000,
  });
}
