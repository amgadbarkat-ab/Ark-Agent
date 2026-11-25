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
  officeQueryOptions,
  setOfficeMutationOptions,
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
  const [copied, setCopied] = useState(false);
  const data = office.data;
  if (!data) return null;

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
      {data.enabled && data.joinCode ? (
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
          <p className="text-sm text-muted-foreground">
            {tNow("This computer: {addresses}, port {port}.", {
              addresses: data.addresses.join(", "),
              port: data.port,
            })}
          </p>
        </div>
      ) : null}
      {data.enabled && !data.addresses.length ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {t(
            "This computer is not connected to a network, so staff cannot reach it. Connect it, then come back here.",
          )}
        </p>
      ) : null}
      {data.error || set.error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {sentenceNow(data.error ?? (set.error as Error).message)}
        </p>
      ) : null}
    </PageSection>
  );
}
