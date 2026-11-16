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

export function importTrialProfileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      text: string,
    ): Promise<{ trial: Trial | null; changed: boolean }> =>
      (
        await client("/api/trial/profile", {
          method: "POST",
          body: { text },
          fallback: "Could not import the trial profile",
        })
      ).json(),
    onSuccess: () => invalidate(queryClient),
  });
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
