import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
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
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type HostAccessPendingOperation,
  type HostFolderGrant,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "@/lib/computers/host-access";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import {
  isDriving,
  type OwnBrowserStatus,
  ownBrowserQueryOptions,
  setOwnBrowserEmployeeMutationOptions,
} from "@/lib/computers/own-browser";
import { computerFleetQueryOptions } from "@/lib/computers/queries";
import { tNow, txNow, useT } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  const t = useT();
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profile, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const nameFor = useBotNames();

  const fleet = useQuery(computerFleetQueryOptions());
  const hostAccess = useQuery(hostAccessQueryOptions());
  const ownBrowser = useQuery(ownBrowserQueryOptions());
  const setOwnBrowser = useMutation(
    setOwnBrowserEmployeeMutationOptions(queryClient),
  );
  const agents = useQuery(agentListQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));
  const requestGrant = useMutation(
    requestHostFolderGrantMutationOptions(queryClient),
  );
  const revokeGrant = useMutation(
    revokeHostFolderGrantMutationOptions(queryClient),
  );
  const stopHostAccess = useMutation(
    stopHostAccessMutationOptions(queryClient),
  );

  const computers = fleet.data?.computers ?? null;
  const isolation = fleet.data?.isolation ?? null;
  /*
   * One line for either failure. A list that could not be read and an action that was refused are
   * both "this did not work", and the page has one place to say so.
   */
  const problem = fleet.error
    ? tNow("The computers could not be listed.")
    : setState.error
      ? setState.error.message
      : null;
  const hostProblem = hostAccess.error
    ? hostAccess.error.message
    : requestGrant.error
      ? requestGrant.error.message
      : revokeGrant.error
        ? revokeGrant.error.message
        : stopHostAccess.error
          ? stopHostAccess.error.message
          : null;

  const run = (botId: string, action: "stop" | "reset") => {
    setBusy(botId);
    setConfirming(null);
    setState.mutate({ action, botId }, { onSettled: () => setBusy(null) });
  };

  return (
    <PageShell
      description={t(
        "Each digital employee's browser and the profile it keeps. A profile is what makes a digital employee still signed in tomorrow, and resetting one signs it out of everything.",
      )}
      title={t("Computers")}
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-medium">
            {t("Every digital employee is sharing one computer.")}
          </span>{" "}
          {txNow(
            "They share its logins, its files and its session, so a digital employee can reach what another signed into. Set {variable} to give each digital employee its own.",
            { variable: <code>{t("COMPUTER_SUPERVISOR_URL")}</code> },
          )}
        </p>
      ) : isolation === "per-bot" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          {t(
            "Each digital employee has a computer of its own: its own container, its own files and its own browser profile.",
          )}
        </p>
      ) : null}

      {ownBrowser.data?.desktop ? (
        <OwnBrowserSection
          botIds={(agents.data ?? []).map((agent) => agent.id)}
          busyBotId={
            setOwnBrowser.isPending
              ? (setOwnBrowser.variables?.botId ?? null)
              : null
          }
          nameFor={nameFor}
          onChoose={(botId, use) => setOwnBrowser.mutate({ botId, use })}
          problem={setOwnBrowser.error ? setOwnBrowser.error.message : null}
          status={ownBrowser.data}
        />
      ) : null}

      <HostFoldersSection
        connected={hostAccess.data?.connected ?? false}
        grants={hostAccess.data?.grants ?? []}
        botIds={(agents.data ?? []).map((agent) => agent.id)}
        loading={hostAccess.isPending || agents.isPending}
        nameFor={nameFor}
        onGrant={(botId) => requestGrant.mutate({ botId })}
        onRevoke={(grantId) => revokeGrant.mutate({ grantId })}
        onStop={() => stopHostAccess.mutate()}
        pending={hostAccess.data?.pending ?? []}
        problem={hostProblem}
        requestingBotId={
          requestGrant.isPending
            ? (requestGrant.variables?.botId ?? null)
            : null
        }
        revokingGrantId={
          revokeGrant.isPending
            ? (revokeGrant.variables?.grantId ?? null)
            : null
        }
        stopping={stopHostAccess.isPending}
      />

      <PageSection title={t("Computers in this deployment")}>
        {computers === null && problem ? (
          <PageEmpty>{t("The list could not be loaded.")}</PageEmpty>
        ) : computers === null ? null : computers.length === 0 ? (
          <PageEmpty>
            {t(
              "No computers yet. One appears the first time a digital employee opens a page.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={computer.botId}>
                      {nameFor(computer.botId)}
                    </ItemTitle>
                    <ItemDescription>
                      {computer.running
                        ? t("Browser running since {value1}", {
                            value1: new Date(
                              computer.startedAt ?? "",
                            ).toLocaleTimeString(),
                          })
                        : t(
                            "No browser running. It starts when the digital employee next needs it.",
                          )}
                      {" · "}
                      {computer.egress === undefined
                        ? t("Egress not reported")
                        : computer.egress === null
                          ? t("Leaves directly")
                          : t("Leaves through {egress}", {
                              egress: computer.egress,
                            })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId ? "Working…" : t("Stop browser")}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
                      size="sm"
                      variant="outline"
                    >
                      {t("Reset")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tNow("Reset {name}'s computer?", {
                name: confirming ? nameFor(confirming) : "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Its profile is deleted, so the digital employee is signed out of every service it had logged into and starts clean. This cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirming(null)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={busy === confirming}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirming ? "Resetting…" : t("Reset it")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-4 text-muted-foreground text-sm">
        {txNow(
          "{stop} closes the browser and keeps its logins: the next thing the digital employee does starts it again where it left off. {reset} deletes the profile, so the digital employee is signed out of everything and starts clean. Both are recorded in {audit}.",
          {
            stop: <strong>{t("Stop")}</strong>,
            reset: <strong>{t("Reset")}</strong>,
            audit: (
              <Link className="underline" to="/admin/audit">
                {t("Audit")}
              </Link>
            ),
          },
        )}
      </p>
    </PageShell>
  );
}

/**
 * Which digital employees work in the person's own Chrome or Edge (device control, phase 1).
 *
 * Only on the desktop app, and only usable while its switch is on. The switch is not here on purpose:
 * it lives in the desktop app's own menu, so nothing a page shows can turn somebody's browser on.
 */
function OwnBrowserSection({
  botIds,
  busyBotId,
  nameFor,
  onChoose,
  problem,
  status,
}: {
  botIds: string[];
  busyBotId: string | null;
  nameFor: (botId: string) => string;
  onChoose: (botId: string, use: boolean) => void;
  problem: string | null;
  status: OwnBrowserStatus;
}) {
  const t = useT();
  const chosen = new Map(
    status.employees.map((choice) => [choice.botId, choice]),
  );
  const sorted = Array.from(new Set([...botIds, ...chosen.keys()])).sort(
    (left, right) => nameFor(left).localeCompare(nameFor(right)),
  );
  return (
    <PageSection
      description={t(
        "Let a digital employee work in your own Chrome or Edge, in a separate ArkAgent profile with none of your saved passwords. Payments, sending, form submissions and deletions wait for your approval, and every action is recorded.",
      )}
      title={t("Your own browser")}
    >
      {problem ? (
        <p
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {!status.available ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {txNow(
            "Switched off. To use it, choose {option} in the ArkAgent menu of the desktop app. Switching it off there, or closing that browser window, ends it at once.",
            {
              option: (
                <span className="font-medium">
                  {t("Let digital employees use my browser")}
                </span>
              ),
            },
          )}
        </p>
      ) : null}
      {sorted.length === 0 ? (
        <PageEmpty>{t("No digital employees yet.")}</PageEmpty>
      ) : (
        <PageRows>
          {sorted.map((botId, index) => {
            const choice = chosen.get(botId);
            return (
              <StaggerItem index={index} key={botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={botId}>{nameFor(botId)}</ItemTitle>
                    <ItemDescription>
                      {choice
                        ? isDriving(choice)
                          ? t("Working in your browser now.")
                          : t("Uses your browser.")
                        : t("Uses its own browser in a sandbox.")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={
                        busyBotId === botId || (!choice && !status.available)
                      }
                      onClick={() => onChoose(botId, !choice)}
                      size="sm"
                      variant="outline"
                    >
                      {busyBotId === botId
                        ? "Working…"
                        : choice
                          ? t("Back to its own browser")
                          : t("Use my browser")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== sorted.length - 1 && <Separator />}
              </StaggerItem>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

type HostFoldersSectionProps = {
  botIds: string[];
  connected: boolean;
  grants: HostFolderGrant[];
  loading: boolean;
  nameFor: (botId: string) => string;
  onGrant: (botId: string) => void;
  onRevoke: (grantId: string) => void;
  onStop: () => void;
  pending: HostAccessPendingOperation[];
  problem: string | null;
  requestingBotId: string | null;
  revokingGrantId: string | null;
  stopping: boolean;
};

function HostFoldersSection({
  botIds: knownBotIds,
  connected,
  grants,
  loading,
  nameFor,
  onGrant,
  onRevoke,
  onStop,
  pending,
  problem,
  requestingBotId,
  revokingGrantId,
  stopping,
}: HostFoldersSectionProps) {
  const t = useT();
  const botIds = Array.from(
    new Set([
      ...knownBotIds,
      ...grants.map((grant) => grant.botId),
      ...pending.map((one) => one.botId),
    ]),
  ).sort((left, right) => nameFor(left).localeCompare(nameFor(right)));

  return (
    <PageSection
      description={t(
        "Choose folders a digital employee can read on this computer. The desktop app asks before each edit or command. Access ends when you stop OpenBot.",
      )}
      title={t("Folders on this computer")}
    >
      {problem ? (
        <p
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {!connected && !loading ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {t(
            "The desktop app is offline. Folders can only be approved from the desktop app, and command access stays unavailable while it is offline.",
          )}
        </p>
      ) : null}

      {loading ? null : botIds.length === 0 ? (
        <PageEmpty>
          {t(
            "No digital employees yet. Create a digital employee before choosing folders.",
          )}
        </PageEmpty>
      ) : (
        <PageRows>
          {botIds.map((botId, index) => (
            <StaggerItem index={index} key={botId}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle title={botId}>{nameFor(botId)}</ItemTitle>
                  <ItemDescription>
                    {summaryFor(botId, grants, pending)}
                  </ItemDescription>
                  <FolderGrantList
                    botId={botId}
                    grants={grants}
                    onRevoke={onRevoke}
                    pending={pending}
                    revokingGrantId={revokingGrantId}
                  />
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={!connected || requestingBotId === botId}
                    onClick={() => onGrant(botId)}
                    size="sm"
                    variant="outline"
                  >
                    {requestingBotId === botId
                      ? "Waiting…"
                      : t("Choose folder")}
                  </Button>
                </ItemActions>
              </Item>
              {index !== botIds.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
        <p>
          {t(
            "Grants are read-only by default. Writes are requested from the native desktop prompt when a digital employee needs them.",
          )}
        </p>
        <div className="flex items-center gap-3">
          <Button
            disabled={!connected || stopping}
            onClick={onStop}
            size="sm"
            variant="outline"
          >
            {stopping ? "Stopping…" : t("Stop folder access")}
          </Button>
          <Link className="underline" to="/admin/audit">
            {t("View audit")}
          </Link>
        </div>
      </div>
    </PageSection>
  );
}

function FolderGrantList({
  botId,
  grants,
  onRevoke,
  pending,
  revokingGrantId,
}: {
  botId: string;
  grants: HostFolderGrant[];
  onRevoke: (grantId: string) => void;
  pending: HostAccessPendingOperation[];
  revokingGrantId: string | null;
}) {
  const botGrants = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  const botPending = pending.filter((request) => request.botId === botId);

  if (botGrants.length === 0 && botPending.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {botGrants.map((grant) => (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
          key={grant.id}
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{grant.displayName}</p>
            <p className="text-muted-foreground text-xs">
              {ownerLabel(grant)} · {tNow("Read-only")}
            </p>
          </div>
          <Button
            disabled={revokingGrantId === grant.id}
            onClick={() => onRevoke(grant.id)}
            size="sm"
            variant="ghost"
          >
            {revokingGrantId === grant.id ? tNow("Revoking…") : tNow("Revoke")}
          </Button>
        </div>
      ))}
      {botPending.map((request) => (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          key={request.operationId}
        >
          {request.displayName
            ? tNow("{what} from {who} for {folder}.", {
                what: pendingLabel(request),
                who: ownerLabel(request),
                folder: request.displayName,
              })
            : tNow("{what} from {who}.", {
                what: pendingLabel(request),
                who: ownerLabel(request),
              })}
        </div>
      ))}
    </div>
  );
}

function summaryFor(
  botId: string,
  grants: HostFolderGrant[],
  pending: HostAccessPendingOperation[],
) {
  const active = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  ).length;
  const waiting = pending.filter((request) => request.botId === botId).length;
  const parts = [];
  if (active > 0)
    parts.push(
      active === 1
        ? tNow("1 read-only folder")
        : tNow("{count} read-only folders", { count: active }),
    );
  if (waiting > 0)
    parts.push(
      waiting === 1
        ? tNow("1 pending request")
        : tNow("{count} pending requests", { count: waiting }),
    );
  return parts.length > 0 ? parts.join(" · ") : tNow("No folders approved.");
}

function ownerLabel(grant: { ownerName?: string; ownerEmail?: string }) {
  return grant.ownerName ?? grant.ownerEmail ?? tNow("the desktop owner");
}

function pendingLabel(request: HostAccessPendingOperation) {
  switch (request.kind) {
    case "write_file":
      return tNow("File change awaiting approval or completion");
    case "run_command":
      return tNow("Command awaiting approval or completion");
    case "list_files":
      return tNow("Listing files");
    case "read_file":
      return "Reading a file";
    case "cancel":
    case "stop":
      return tNow("Stopping folder work");
    default:
      return tNow("Folder access awaiting approval");
  }
}
