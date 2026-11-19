/**
 * Activation on Settings, then Plan (#109, v0.1.42): where this install stands, the renewal, and the
 * box for a new code or key (a renewed licence key typed by hand, or a trial code). Hidden where
 * activation is not required and nothing was ever entered.
 */
import { IconLicense } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivationForm,
  useActivationLine,
} from "@/components/activation/activation-form";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  activationQueryOptions,
  agentAllowanceQueryOptions,
} from "@/lib/trial/queries";

export function ActivationSection({ admin }: { admin: boolean }) {
  const t = useT();
  const line = useActivationLine();
  const activation = useQuery(activationQueryOptions()).data;
  const agents = useQuery(agentAllowanceQueryOptions()).data;
  if (!activation) return null;
  if (!activation.required && activation.state === "none") return null;

  return (
    <PageSection
      description={t(
        "ArkAgent works on this computer with a trial activation code, a paid licence key or the trial setup file.",
      )}
      title={t("Activation")}
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconLicense />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{line(activation)}</ItemTitle>
            {agents && agents.limit !== null ? (
              // Ark Team's agent limit (v0.1.49), for the whole computer.
              <ItemDescription className="line-clamp-none">
                {t("Digital employees on this computer: {inUse} of {limit}.", {
                  inUse: agents.inUse,
                  limit: agents.limit,
                })}
              </ItemDescription>
            ) : null}
            {activation.renewHost ? (
              <ItemDescription className="line-clamp-none">
                {t(
                  "Once a day this computer asks {host} for the renewed licence key. Only the customer id, this computer's random id, the version and the key's number are sent.",
                  { host: activation.renewHost },
                )}{" "}
                {activation.lastRenewError
                  ? t("The last renewal check did not go through.")
                  : activation.lastRenewAt
                    ? t("Last checked: {when}.", {
                        when: new Date(activation.lastRenewAt).toLocaleString(
                          dateLocale(),
                        ),
                      })
                    : ""}
              </ItemDescription>
            ) : null}
          </ItemContent>
        </Item>
        {admin ? (
          <>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ActivationForm showFileImport={false} />
              </ItemContent>
            </Item>
          </>
        ) : null}
      </PageRows>
    </PageSection>
  );
}
