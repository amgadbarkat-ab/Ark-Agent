import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type CloudRates, cloudKeys } from "./queries";

const FALLBACK = "Could not change cloud running";

/*
 * Settled, not just succeeded: a refusal because the prices moved is itself the reason to read them
 * again, and the screen should be showing the new ones when the person reads the error.
 */
const reread = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: cloudKeys.all });

/** Switch it on having read the prices, with a monthly limit. The prices sent are the ones shown. */
export function enableCloudMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      monthlyCapCents: number;
      shownRates: CloudRates;
    }): Promise<void> => {
      await client("/api/account/cloud/enable", {
        method: "POST",
        body: variables,
        fallback: "Could not switch cloud running on",
      });
    },
    onSettled: reread(queryClient),
  });
}

export function setCloudCapMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (monthlyCapCents: number): Promise<void> => {
      await client("/api/account/cloud/cap", {
        method: "PUT",
        body: { monthlyCapCents },
        fallback: "Could not change the limit",
      });
    },
    onSettled: reread(queryClient),
  });
}

export function disableCloudMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      await client("/api/account/cloud/disable", {
        method: "POST",
        fallback: "Could not switch cloud running off",
      });
    },
    onSettled: reread(queryClient),
  });
}

/** Staff: set what running in the cloud is priced at. */
export function setCloudRatesMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (rates: CloudRates): Promise<void> => {
      await client("/api/admin/cloud/rates", {
        method: "PUT",
        body: rates,
        fallback: FALLBACK,
      });
    },
    onSuccess: reread(queryClient),
  });
}

/** Staff: say what became of a month the machine could not decide. */
export function settleCloudChargeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      chargeId: string;
      outcome: "charged" | "waived";
      note: string;
    }): Promise<void> => {
      await client(`/api/admin/cloud/charges/${variables.chargeId}/settle`, {
        method: "POST",
        body: { outcome: variables.outcome, note: variables.note },
        fallback: "Could not settle that month",
      });
    },
    onSuccess: reread(queryClient),
  });
}
