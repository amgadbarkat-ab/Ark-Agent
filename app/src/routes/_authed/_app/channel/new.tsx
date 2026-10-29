import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { canSend, type Recipient } from "@/components/channels/compose-state";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { addressedOutside } from "@/components/channels/mention-handoff";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { startChosen, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const chosen =
    listed ??
    (fetched?.id === agent ? fetched : undefined) ??
    (agent ? undefined : defaultAgentProfile(profiles));
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? "Digital employees couldn't be loaded."
      : urlAgentDetailFailed
        ? "Digital employee couldn't be loaded."
        : null;
  const recipients: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const skillCommands = useSkillCommands(chosen?.id ?? "");

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>
        <Combobox
          // Do not auto-open when the recipient came from the URL; the field is already answered.
          defaultOpen={!chosen && !loadError && !waitingForUrlAgent}
          autoHighlight
          items={profiles ?? []}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next) => {
            // Recipient changes are not separate navigation history entries.
            void navigate({
              replace: true,
              search: next ? { agent: next.id } : {},
            });
          }}
          value={chosen ?? null}
        >
          <ComboboxInput
            // The popup opening is not enough on its own: typing filters through this input, so
            // the caret starts here whenever the recipient question is still open. Same condition
            // as `defaultOpen` — a recipient from the URL means the composer takes focus instead.
            autoFocus={!chosen}
            placeholder="Choose a digital employee…"
            // InputGroup owns focus rings via `has-[…:focus-visible]`; disable that wrapper ring here.
            className="border-none w-full bg-transparent! text-sm has-[[data-slot=input-group-control]:focus-visible]:ring-0"
          />
          {/* Allow max-w to constrain the popup even though its anchor is full-width. */}
          <ComboboxContent className="min-w-0 max-w-lg" sideOffset={12}>
            <ComboboxEmpty>No agents found.</ComboboxEmpty>
            <ComboboxList>
              {(item: AgentProfile) => (
                <ComboboxItem key={item.id} value={item} className="h-10">
                  <ChannelAvatar participantIds={[item.id]} size={24} />
                  {item.name}
                  <span className="truncate text-muted-foreground ml-1">
                    {item.title}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <ConversationView
        /*
         * The `@` menu lists every digital employee, the same roster an open conversation offers.
         * This screen used to pass nothing, so the menu was empty ("No agents in this channel") —
         * and it is the screen the person is on whenever they open an employee they have not talked
         * to yet: the DT Lab (v0.1.17) opened Customer Support, typed `@Chief`, found nobody to
         * pick, sent anyway, and Customer Support answered a message meant for the Chief of
         * Operations. v0.1.17 had wired the roster into `ChannelChat` only, and tested it there.
         */
        agents={toAgentOptions(profiles)}
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;
          // An `@` for somebody other than the To: recipient is the later, more specific choice, so
          // the conversation starts with them — the rule an open conversation follows through
          // `addressedOutside`, applied before there is a conversation to be outside of.
          const addressed =
            addressedOutside(draft, toAgentOptions(profiles), [recipient.id]) ??
            recipient;

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
            // home screen, and the trail has to say so for both.
            await startChosen(addressed.id, draft.text);
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
