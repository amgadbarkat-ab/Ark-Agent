import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type SupportPayload,
  type SupportRequest,
  supportKeys,
} from "./queries";

export type SupportInput = {
  subject: string;
  message: string;
  urgent: boolean;
  includeDiagnostics: boolean;
  language: "el" | "en";
  /** Before activation only: where BlackArk may answer, if the person gives it. */
  contactEmail?: string;
  /** The preview the person read, so that exactly it is sent. */
  previewId?: string;
};

const FALLBACK = "Could not reach Help & support";

/** Exactly what would be sent, for the person to read before sending. Changes nothing. */
export function previewSupportRequest(
  input: SupportInput,
): Promise<SupportPayload> {
  return client("/api/support/preview", "payload", {
    method: "POST",
    body: input,
    fallback: FALLBACK,
  });
}

/** Sends the request; when BlackArk cannot be reached it is kept and sent again later. */
export function sendSupportRequestMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: SupportInput): Promise<SupportRequest> =>
      client("/api/support/requests", "request", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: supportKeys.all }),
  });
}
