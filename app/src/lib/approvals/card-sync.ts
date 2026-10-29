import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  decideApprovalMutationOptions,
  registerApprovalCardMutationOptions,
} from "./mutations";
import { approvalQueryOptions } from "./queries";

/** The conversation on screen, read from the address so a card needs no router to work out where it is. */
function channelOnScreen(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname.match(/\/channel\/([^/]+)/)?.[1];
}

/**
 * Keeps an approval card in a conversation and its row in Requests in step, in both directions.
 *
 * WHY. The card is what resumes the employee's run — its answer is the tool result — but it lives in
 * one conversation, and a person who is not looking at that conversation never sees it. Desk #69 was
 * the Requests page saying "Nothing is waiting for you" while a card waited. So a card that is
 * waiting registers itself as a request; a decision taken in Requests is noticed here and answers
 * the card exactly as pressing its button would; and an answer given on the card is recorded on the
 * row so the list and the "Needs you" count clear.
 *
 * Only a card that is actually waiting registers, and only one with a tool call to key on: the
 * gallery's preview of the card has neither, and a card answered before this existed is history,
 * not a request.
 */
export function useApprovalCardSync(input: {
  toolCallId: string | undefined;
  agentId: string | undefined;
  waiting: boolean;
  title: string | undefined;
  summary: string | undefined;
  details: { label: string; value: string }[] | undefined;
  /** Answers the card, which resumes the run. Present only while it is waiting. */
  respond: ((result: unknown) => Promise<void>) | undefined;
}) {
  const queryClient = useQueryClient();
  const register = useMutation(
    registerApprovalCardMutationOptions(queryClient),
  );
  const decide = useMutation(decideApprovalMutationOptions(queryClient));
  const [id, setId] = useState<string | null>(null);
  const asked = useRef(false);
  const answered = useRef(false);

  const { toolCallId, agentId, waiting, title, summary, details, respond } =
    input;

  useEffect(() => {
    if (!waiting || !toolCallId || !agentId || !title || asked.current) return;
    asked.current = true;
    const channelId = channelOnScreen();
    register
      .mutateAsync({
        toolCallId,
        agentId,
        title,
        ...(channelId ? { channelId } : {}),
        ...(summary ? { summary } : {}),
        ...(details?.length ? { details } : {}),
      })
      .then((row) => {
        if (row) setId(row.id);
      })
      .catch(() => {
        // Listing is a convenience on top of the card, which still works on its own.
      });
  }, [waiting, toolCallId, agentId, title, summary, details, register]);

  const row = useQuery(approvalQueryOptions(waiting ? id : null));

  // Decided in Requests while the card waits: answer the card the way its own buttons would.
  useEffect(() => {
    const status = row.data?.status;
    if (!waiting || !respond || answered.current || !status) return;
    if (status === "pending") return;
    answered.current = true;
    void respond({
      decision: status === "approved" ? "approved" : "declined",
      note:
        status === "approved"
          ? "Approved from Requests."
          : status === "expired"
            ? "Nobody answered in time, so this lapsed."
            : "Declined from Requests.",
    }).catch(() => {
      // The run being gone is not worth reporting: there is nothing left to answer.
    });
  }, [row.data?.status, waiting, respond]);

  /** Record an answer given on the card, so the list and the count clear. */
  return {
    record(decision: "approved" | "declined") {
      answered.current = true;
      if (!id) return;
      decide.mutate({
        id,
        decision: decision === "approved" ? "approve" : "reject",
      });
    },
  };
}
