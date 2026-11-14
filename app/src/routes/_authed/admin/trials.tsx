import { IconCalendarTime } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { dateLocale, useT } from "@/lib/i18n";
import {
  type TrialInstall,
  trialInstallsQueryOptions,
} from "@/lib/trial/queries";

export const Route = createFileRoute("/_authed/admin/trials")({
  component: TrialsPage,
});

/**
 * Customer trials reporting to this server (#109): one row per install, with what it last said.
 * Only BlackArk's own server receives check-ins (ARK_TRIAL_RECEIVER=true); anywhere else the list is
 * not there, and the page says so.
 */
function TrialsPage() {
  const t = useT();
  const installs = useQuery(trialInstallsQueryOptions());
  const words: Record<TrialInstall["status"], string> = {
    trial: t("on trial"),
    ended: t("ended"),
    paid: t("paid"),
  };

  return (
    <PageShell
      description={t(
        "Each install of a customer trial reports its status and days left once a day. Nothing else is sent.",
      )}
      title={t("Trials")}
    >
      <PageSection title={t("Installs")}>
        {installs.isPending ? null : installs.error ? (
          <PageEmpty>
            {t("This server does not receive trial check-ins.")}
          </PageEmpty>
        ) : installs.data.installs.length === 0 ? (
          <PageEmpty>{t("No install has checked in yet.")}</PageEmpty>
        ) : (
          <PageRows>
            {installs.data.installs.map((install, index) => (
              <React.Fragment key={install.installId}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconCalendarTime />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {install.customerId} · {words[install.status]}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {t(
                        "{days} days left · version {version} · last check-in {when}",
                        {
                          days: install.daysLeft,
                          version: install.version,
                          when: new Date(install.lastSeenAt).toLocaleString(
                            dateLocale(),
                          ),
                        },
                      )}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                {index !== installs.data.installs.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
