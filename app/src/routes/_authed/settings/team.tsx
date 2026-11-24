import { IconUserPlus, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { MemberForm } from "@/components/settings/team-member-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { tNow, useT } from "@/lib/i18n";
import { removeSubprofileMutationOptions } from "@/lib/team/mutations";
import { type TeamMember, teamMembersQueryOptions } from "@/lib/team/queries";
import { queryClient } from "@/query-client";

/**
 * Settings, then Team (Amgad, 24 Nov 2026): the administrator adds staff who sign in as themselves,
 * each EUR 15 a month excl. VAT on top of Ark Team, active once paid. Each sub-profile has exactly
 * the digital employees the administrator gives it, and an employee belongs to one sub-profile at a
 * time: giving it to another moves it, after the administrator confirms who loses it.
 */
export const Route = createFileRoute("/_authed/settings/team")({
  component: TeamPage,
});

const STATUS: Record<TeamMember["status"], string> = {
  active: tNow("Active"),
  pending_payment: tNow("Waiting for payment"),
  suspended: tNow("Suspended: payment did not go through"),
  removed: tNow("Removed"),
};

function TeamPage() {
  const t = useT();
  const members = useQuery(teamMembersQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const remove = useMutation(removeSubprofileMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const names = new Map((agents.data ?? []).map((a) => [a.id, a.name]));

  return (
    <PageShell
      description={t(
        "Add the people who work with you. Each signs in as themselves, on any computer, and uses only the digital employees you give them. Each sub-profile is €15 a month excl. VAT, on top of your Ark Team plan, and can sign in once it is paid.",
      )}
      title={t("Team")}
    >
      <PageSection title={t("People")}>
        {members.isPending ? null : members.error ? (
          <p className="text-sm text-destructive" role="alert">
            {t("The team could not be loaded.")}
          </p>
        ) : (
          <PageRows>
            {(members.data ?? []).map((member, index) => (
              <div key={member.userId}>
                {index === 0 ? null : <Separator />}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconUsers />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {member.name} · {member.email}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {member.role === "admin"
                        ? t("Administrator: every digital employee")
                        : `${STATUS[member.status]} · ${
                            member.agentIds
                              .map((id) => names.get(id) ?? id)
                              .join(", ") || t("No digital employees")
                          }`}
                    </ItemDescription>
                  </ItemContent>
                  {member.role === "subprofile" ? (
                    <ItemActions>
                      <Button
                        onClick={() => setEditing(member)}
                        size="sm"
                        variant="outline"
                      >
                        {t("Digital employees")}
                      </Button>
                      <Button
                        onClick={() => setRemoving(member)}
                        size="sm"
                        variant="ghost"
                      >
                        {t("Remove")}
                      </Button>
                    </ItemActions>
                  ) : null}
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => setAdding(true)} size="sm">
            <IconUserPlus />
            {t("Add a sub-profile")}
          </Button>
          {checkoutUrl ? (
            <Button
              render={
                <a
                  href={checkoutUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                />
              }
              size="sm"
              variant="outline"
            >
              {t("Pay for the new sub-profile")}
            </Button>
          ) : null}
        </div>
      </PageSection>

      {adding ? (
        <MemberDialog
          agents={agents.data ?? []}
          onClose={(url) => {
            setAdding(false);
            if (url) setCheckoutUrl(url);
          }}
        />
      ) : null}
      {editing ? (
        <MemberDialog
          agents={agents.data ?? []}
          member={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <Dialog
        onOpenChange={(open) => (open ? null : setRemoving(null))}
        open={removing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Remove this sub-profile?")}</DialogTitle>
            <DialogDescription>
              {t(
                "They are signed out at once, their digital employees are free to give to somebody else, and the €15 a month stops (prorated).",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setRemoving(null)} variant="outline">
              {t("Keep")}
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.userId, {
                  onSuccess: () => setRemoving(null),
                })
              }
              variant="destructive"
            >
              {t("Remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {members.data?.length === 0 ? <PageEmpty>{""}</PageEmpty> : null}
    </PageShell>
  );
}

/** Adding a sub-profile, or changing one's employees, in a dialog. */
function MemberDialog({
  agents,
  member,
  onClose,
}: {
  agents: AgentProfile[];
  member?: TeamMember;
  onClose: (checkoutUrl?: string | null) => void;
}) {
  const t = useT();
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {member
              ? tNow("Digital employees for {name}", { name: member.name })
              : t("Add a sub-profile")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Choose exactly which digital employees this person can use and chat with. A digital employee belongs to one sub-profile at a time.",
            )}
          </DialogDescription>
        </DialogHeader>
        <MemberForm agents={agents} member={member} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
