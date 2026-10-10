import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { currentSubscription, subscribeDevice } from "@/lib/push/device";
import { type PushTestResult, pushKeys } from "@/lib/push/queries";

const FALLBACK = "Could not change notifications";

function invalidate(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: pushKeys.all });
}

/**
 * Turn notifications on for this browser: allow, subscribe, tell the server.
 *
 * If the server will not take the subscription, the browser's is dropped again, so this browser is
 * never left believing it is subscribed to something nobody will send to.
 */
export function enablePushMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (publicKey: string): Promise<void> => {
      const { record, unsubscribe } = await subscribeDevice(publicKey);
      try {
        await client("/api/push/subscription", {
          method: "PUT",
          body: record,
          fallback: FALLBACK,
        });
      } catch (thrown) {
        await unsubscribe().catch(() => undefined);
        throw thrown;
      }
    },
    onSettled: () => invalidate(queryClient),
  });
}

/** Turn them off here: the server forgets this browser first, then the browser lets go. */
export function disablePushMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      const subscription = await currentSubscription();
      if (!subscription) return;
      await client("/api/push/subscription", {
        method: "DELETE",
        body: { endpoint: subscription.endpoint },
        fallback: FALLBACK,
      });
      await subscription.unsubscribe();
    },
    onSettled: () => invalidate(queryClient),
  });
}

/**
 * Send this person's devices a notification now. A button somebody pressed, so a write; it changes
 * nothing that is cached, because a notification is not state the screen shows.
 */
export function testPushMutationOptions() {
  return mutationOptions({
    mutationFn: async (): Promise<PushTestResult> =>
      (
        await client("/api/push/test", {
          method: "POST",
          fallback: "Could not send a test notification",
        })
      ).json(),
  });
}
