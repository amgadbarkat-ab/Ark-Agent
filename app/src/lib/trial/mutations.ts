import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { accountKeys } from "@/lib/account/queries";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { type Activation, type Trial, trialKeys } from "./queries";

/** The trial changes the plan, the end and who may be made, so all three are read again. */
function invalidate(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: trialKeys.all }),
    queryClient.invalidateQueries({ queryKey: accountKeys.all }),
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  ]);
}

export function applyUnlockCodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      code: string,
    ): Promise<{ trial: Trial; action: "extend" | "end" | "paid" }> =>
      (
        await client("/api/trial/unlock", {
          method: "POST",
          body: { code },
          fallback: "Could not use the unlock code",
        })
      ).json(),
    onSuccess: () => invalidate(queryClient),
  });
}

/** The free trial, step one (v0.1.58): blackark.uk emails a 6-digit code to this address. */
export function startSelfServeTrialMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      company: string;
      email: string;
      language: "el" | "en";
    }): Promise<{ sent: boolean }> =>
      (
        await client("/api/activation/trial/start", {
          method: "POST",
          body: input,
          fallback: "Could not send the code",
        })
      ).json(),
  });
}

/** The free trial, step two: the emailed code starts the 7-day trial on this computer. */
export function confirmSelfServeTrialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      email: string;
      code: string;
    }): Promise<{ kind: "trial"; changed: boolean; activation: Activation }> =>
      (
        await client("/api/activation/trial/confirm", {
          method: "POST",
          body: input,
          fallback: "Could not check the code",
        })
      ).json(),
    onSuccess: () => invalidate(queryClient),
  });
}

/** The one box: a trial activation code, a licence key, or an unlock code (#109, v0.1.42). */
export function applyActivationCodeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      code: string,
    ): Promise<{
      kind: "trial" | "license" | "extend" | "end" | "paid";
      changed: boolean;
      activation: Activation;
    }> =>
      (
        await client("/api/activation/code", {
          method: "POST",
          body: { code },
          fallback: "Could not use the code",
        })
      ).json(),
    onSuccess: () => invalidate(queryClient),
  });
}

/**
 * The buy button (v0.1.49): tells the server the buy page is being opened, so it asks for the key
 * every 20 seconds for the next half hour, and gets back the page for this install's customer.
 */
export function openBuyPageMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<{ buyUrl: string }> =>
      (
        await client("/api/activation/buying", {
          method: "POST",
          fallback: "Could not open the buy page",
        })
      ).json(),
  });
}
