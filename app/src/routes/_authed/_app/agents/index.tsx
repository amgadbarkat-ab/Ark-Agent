import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { OpenTeamChannelButton } from "@/components/agents/open-team-channel-button";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { HireSection } from "@/components/marketplace/hire-section";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentProfile,
  agentListQueryOptions,
  isSharedWithYou,
} from "@/lib/agents/queries";

/**
 * Creating and inspecting a digital employee are search-parameter states so the page remains mounted
 * and Back closes the dialog.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: DigitalTeamScreen,
});

/**
 * Everything about who works for you, on one page: the team you have, the ready-made digital employees
 * you can hire, the ones shared with you, and where you make your own or share one.
 *
 * It used to be two pages, Agents and Marketplace, and a person had to know that a digital employee they
 * had hired would appear on the other one. One page means hiring, creating and sharing all end in the
 * same place: the team at the top.
 */
function DigitalTeamScreen() {
  const { new: isCreating, agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  /*
   * The empty states below must not fire while the list is still arriving: an empty state standing
   * there saying somebody has nobody on their team is a claim the screen has not yet earned.
   *
   * `isPending` rather than `agents === undefined`, because `data` is also undefined when the query
   * FAILED, so deriving the flag from it would hold the screen in its loading branch for ever on an
   * error. `isPending` goes false either way, so a failure falls through to its own message.
   */
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const mine = agents?.filter((a) => a.mine);
  const shared = agents?.filter(isSharedWithYou);

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = isCreating === true;
  const showProfile = !showCreate && selectedAgentId !== undefined;
  const close = () => navigate({ search: {} });

  return (
    <>
      <PageShell
        action={
          <div className="flex items-center gap-1">
            {/* A team needs somebody besides the lead. */}
            {(mine?.length ?? 0) >= 2 ? <OpenTeamChannelButton /> : null}
            <Button
              render={(props) => (
                <Link search={{ new: true }} to="/agents" {...props} />
              )}
              size="sm"
              variant="ghost"
            >
              <IconPlus />
              Create your own
            </Button>
          </div>
        }
        description="Everyone who works for you. Look after your team, hire a ready-made digital employee for a role, create your own, or share one with others."
        title="Digital Team"
      >
        <PageSection title="Your digital team">
          <Roster
            agents={mine}
            emptyText={
              (shared?.length ?? 0) > 0
                ? "You don't have digital employees of your own yet. The ones on the home page are shared with everybody here, and are listed under Shared with you below. Hire one, or create your own, to build a team that works for you."
                : "You don't have any digital employees yet. Hire one below, or create your own."
            }
            failed={failed}
            failedText="Your digital team couldn't be loaded."
            loading={loading}
          />
        </PageSection>
        <HireSection />
        <PageSection title="Shared with you">
          <Roster
            agents={shared}
            emptyText="Nobody has shared a digital employee with you yet."
            failed={failed}
            failedText="Digital employees shared with you couldn't be loaded."
            loading={loading}
          />
        </PageSection>
      </PageShell>
      <CreateAgentDialog
        onClose={close}
        onCreated={(agentId) => navigate({ search: { agent: agentId } })}
        open={showCreate}
      />
      <AgentDialog
        agentId={selectedAgentId ?? null}
        onClose={close}
        open={showProfile}
      />
    </>
  );
}

/** A grid of digital employees, or the one sentence that says why there is none. */
function Roster({
  agents,
  emptyText,
  failed,
  failedText,
  loading,
}: {
  agents: AgentProfile[] | undefined;
  emptyText: string;
  failed: boolean;
  failedText: string;
  loading: boolean;
}) {
  if (loading) {
    // Approximate one row of cards while the roster loads.
    return <Skeleton className="mt-4 h-[180px]" />;
  }
  /*
   * A roster that has loaded wins over `failed`: TanStack Query keeps the last good `data` across a
   * failed background refetch, so `isError` and a populated list are an ordinary combination, and a
   * stale roster beats an error card claiming there is nobody.
   */
  if (agents?.length) {
    return (
      <div className="mt-4 grid grid-cols-2 gap-4">
        {agents.map((agent, index) => (
          <StaggerItem className="min-w-0" index={index} key={agent.id}>
            <AgentCard agent={agent} />
          </StaggerItem>
        ))}
      </div>
    );
  }
  /*
   * `agents === undefined` narrows this to "the query has never once returned": an empty list that
   * loaded is a fact about the roster, not a symptom of the failure, and the destructive card would
   * say the opposite of what the other roster on this page proves with real cards.
   */
  if (failed && agents === undefined) {
    return (
      <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
        <EmptyHeader>
          <EmptyTitle className="text-destructive">{failedText}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty className="mt-4 h-[180px] border border-dashed">
      <EmptyHeader>
        <EmptyTitle className="text-muted-foreground">{emptyText}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}
