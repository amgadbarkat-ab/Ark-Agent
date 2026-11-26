import { IconCopy } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { sentenceNow, tNow, useT } from "@/lib/i18n";
import {
  newJoinCodeMutationOptions,
  officeQueryOptions,
  setOfficeMutationOptions,
  setRemoteStaffMutationOptions,
} from "@/lib/team/office";
import { queryClient } from "@/query-client";

/**
 * Settings, then Team, then Office network (Amgad, 24 Nov 2026, option A): the administrator lets
 * staff computers on the same network sign in to this one, and gives them the join code. Off until
 * switched on. Hidden where it is not offered.
 */
export function OfficeNetworkSection() {
  const t = useT();
  const office = useQuery(officeQueryOptions());
  const set = useMutation(setOfficeMutationOptions(queryClient));
  const setRemote = useMutation(setRemoteStaffMutationOptions(queryClient));
  const renew = useMutation(newJoinCodeMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  const data = office.data;
  if (!data) return null;
  const remote = data.remote;
  const anyOn = data.enabled || remote?.enabled;
  const failed = set.error ?? setRemote.error ?? renew.error;

  return (
    <PageSection title={t("Office network")}>
      <Item size="sm" variant="outline">
        <ItemContent>
          <ItemTitle>
            {t("Let my staff sign in from this office network")}
          </ItemTitle>
          <ItemDescription className="line-clamp-none">
            {t(
              'Your staff install ArkAgent on their own computers, choose "Join my company\'s ArkAgent", enter the join code below and sign in with their own sub-profile. Everything stays on this computer, so it must be on and connected while they work. Only over HTTPS, and nobody gets in without signing in.',
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label={t("Let my staff sign in from this office network")}
            checked={data.enabled}
            disabled={set.isPending}
            onCheckedChange={(next) => set.mutate(next)}
          />
        </ItemActions>
      </Item>
      {remote?.available ? (
        <Item className="mt-3" size="sm" variant="outline">
          <ItemContent>
            <ItemTitle>
              {t("Let my staff sign in from outside the office")}
            </ItemTitle>
            <ItemDescription className="line-clamp-none">
              {t(
                "Through BlackArk's relay, for staff working from home or on the road. The relay passes their encrypted connection to this computer and cannot read it: passwords, chats and files stay between their computer and this one. This computer must be on and connected to the internet while they work.",
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label={t("Let my staff sign in from outside the office")}
              checked={remote.enabled}
              disabled={setRemote.isPending}
              onCheckedChange={(next) => setRemote.mutate(next)}
            />
          </ItemActions>
        </Item>
      ) : null}
      {remote?.enabled ? (
        <p
          className={
            remote.connected
              ? "mt-3 text-sm text-muted-foreground"
              : "mt-3 text-sm text-destructive"
          }
          role={remote.connected ? undefined : "alert"}
        >
          {remote.connected
            ? t("Connected to BlackArk's relay.")
            : remote.error
              ? sentenceNow(remote.error)
              : t("Connecting to BlackArk's relay…")}
        </p>
      ) : null}
      {anyOn && data.joinCode ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="office-join-code">
            {t("Join code")}
          </label>
          <div className="flex gap-2">
            <Input
              className="font-mono"
              id="office-join-code"
              readOnly
              value={data.joinCode}
            />
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(data.joinCode ?? "")
                  .then(() => setCopied(true));
              }}
              size="sm"
              variant="outline"
            >
              <IconCopy />
              {copied ? t("Copied") : t("Copy")}
            </Button>
          </div>
          {data.enabled ? (
            <p className="text-sm text-muted-foreground">
              {tNow("This computer: {addresses}, port {port}.", {
                addresses: data.addresses.join(", "),
                port: data.port,
              })}
            </p>
          ) : null}
          {remote?.enabled ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={renew.isPending}
                onClick={() => {
                  setCopied(false);
                  renew.mutate();
                }}
                size="sm"
                variant="outline"
              >
                {t("Make a new join code")}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t(
                  "The old code then stops working outside the office. Give the new one to your staff.",
                )}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {data.enabled && !data.addresses.length ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {t(
            "This computer is not connected to a network, so staff cannot reach it. Connect it, then come back here.",
          )}
        </p>
      ) : null}
      {data.error || failed ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {sentenceNow(data.error ?? (failed as Error).message)}
        </p>
      ) : null}
    </PageSection>
  );
}
