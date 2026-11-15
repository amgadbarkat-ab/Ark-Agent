import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { pluginKeys } from "@/lib/plugins/queries";

/** A person's own mailbox login (#109). The password goes to the server once and never comes back. */
export type MailboxLogin = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  password: string;
  fromAddress?: string;
  fromName?: string;
};

export function connectMailboxMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      login: MailboxLogin,
    ): Promise<{ connected: true; account: string }> =>
      (
        await client("/api/plugins/mailbox/connection", {
          method: "POST",
          body: login,
          fallback: "The mailbox could not be connected",
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });
}

export function disconnectMailboxMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<{ disconnected: boolean }> =>
      (
        await client("/api/plugins/mailbox/connection", {
          method: "DELETE",
          fallback: "The mailbox could not be disconnected",
        })
      ).json(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });
}
