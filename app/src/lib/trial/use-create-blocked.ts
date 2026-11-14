import { useQuery } from "@tanstack/react-query";
import { useT } from "@/lib/i18n";
import { queryClient } from "@/query-client";
import { trialQueryOptions } from "./queries";

/**
 * Why a new digital employee cannot be made right now, or null when it can (#109).
 *
 * The server refuses anyway, on every path; this is so the buttons say so before anybody presses
 * them. The sentence is the server's own, so the screen and the refusal read the same.
 */
export function useCreateBlocked(): string | null {
  const t = useT();
  // The app's one client, named rather than taken from context, so a card drawn on its own (in a
  // transcript, in a test) asks the same question without a provider around it.
  const { data } = useQuery(trialQueryOptions(), queryClient);
  return data?.trial?.createBlocked
    ? t(
        "During the trial you cannot create extra digital employees. The trial employees are already set up.",
      )
    : null;
}
