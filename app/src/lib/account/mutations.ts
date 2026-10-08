import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { accountKeys, type SubscriptionStatus } from "./queries";

const FALLBACK = "Could not change the plan";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: accountKeys.all });
}

/**
 * Start buying a plan. Answers where to pay; the caller sends the person there.
 *
 * Not invalidated on success: nothing has changed yet. The plan changes when the payment provider
 * tells the server so, and the page reads it fresh when the person comes back.
 */
export function choosePlanMutationOptions() {
  return mutationOptions({
    mutationFn: async (planId: string): Promise<{ checkoutUrl: string }> =>
      (
        await client("/api/account/plan", {
          method: "POST",
          body: { planId },
          fallback: "Could not start the payment",
        })
      ).json(),
  });
}

export function openBillingPortalMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<{ portalUrl: string }> =>
      (
        await client("/api/account/portal", {
          method: "POST",
          fallback: "Could not open the billing page",
        })
      ).json(),
  });
}

export function cancelPlanMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      await client("/api/account/cancel", {
        method: "POST",
        fallback: "Could not cancel the plan",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

/** Staff: set what an account has bought, by hand. */
export function setAccountPlanMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      tenantId: string;
      planId: string;
      status?: SubscriptionStatus;
    }): Promise<void> => {
      await client(`/api/admin/accounts/${variables.tenantId}/plan`, {
        method: "PUT",
        body: {
          planId: variables.planId,
          ...(variables.status ? { status: variables.status } : {}),
        },
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function suspendAccountMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      tenantId: string;
      reason: string;
    }): Promise<void> => {
      await client(`/api/admin/accounts/${variables.tenantId}/suspend`, {
        method: "POST",
        body: { reason: variables.reason },
        fallback: "Could not suspend the account",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function resumeAccountMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (tenantId: string): Promise<void> => {
      await client(`/api/admin/accounts/${tenantId}/resume`, {
        method: "POST",
        fallback: "Could not restore the account",
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}
