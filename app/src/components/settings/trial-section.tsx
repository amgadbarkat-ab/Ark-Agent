/**
 * The trial on this install (#109), on Settings, then Plan: until when, how many days are left, and
 * an unlock code for an administrator. Shown only when there is a trial.
 *
 * The same for every customer (v0.1.50): it never names the customer, and there is no profile import
 * here. A trial profile is loaded by BlackArk staff in the setup session, from the import folder
 * (docs/trials/README.md).
 */
import { IconCalendarTime, IconKey } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { dateLocale, useT } from "@/lib/i18n";
import { applyUnlockCodeMutationOptions } from "@/lib/trial/mutations";
import { type Trial, trialQueryOptions } from "@/lib/trial/queries";
import { queryClient } from "@/query-client";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(dateLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function useTrialLines() {
  const t = useT();
  return (trial: Trial) => {
    const period = t("{start} to {end}, {days} days", {
      start: day(trial.startsAt),
      end: day(trial.endsAt),
      days: trial.lengthDays,
    });
    const state =
      trial.status === "paid"
        ? t("Converted to paid. No end date, and no limit on new employees.")
        : trial.status === "ended"
          ? t(
              "The trial has ended. Your conversations and settings are kept. Enter an unlock code to continue.",
            )
          : trial.daysLeft === 1
            ? t("1 day left.")
            : t("{days} days left.", { days: trial.daysLeft });
    return { period, state };
  };
}

export function TrialSection({ admin }: { admin: boolean }) {
  const t = useT();
  const lines = useTrialLines();
  const overview = useQuery(trialQueryOptions());
  const unlock = useMutation(applyUnlockCodeMutationOptions(queryClient));
  const [code, setCode] = useState("");
  const codeId = useId();

  const trial = overview.data?.trial ?? null;
  if (overview.isPending || overview.error || !trial) return null;

  const { period, state } = lines(trial);

  return (
    <PageSection
      description={t("Your trial, set by BlackArk.")}
      title={t("Trial")}
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconCalendarTime />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{period}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {state}
              {trial.createBlocked
                ? ` ${t("{count} trial employees are set up; no others can be created.", { count: trial.rosterSize })}`
                : ""}
            </ItemDescription>
          </ItemContent>
        </Item>
        {trial.checkInHost ? (
          <>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{t("Daily check-in")}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {t(
                    "Once a day this computer tells {host} the trial status and the days left. Nothing about your conversations or files is sent.",
                    { host: trial.checkInHost },
                  )}{" "}
                  {trial.lastCheckInError
                    ? t("The last check-in did not go through.")
                    : trial.lastCheckInAt
                      ? t("Last check-in: {when}.", {
                          when: new Date(trial.lastCheckInAt).toLocaleString(
                            dateLocale(),
                          ),
                        })
                      : ""}
                </ItemDescription>
              </ItemContent>
            </Item>
          </>
        ) : null}
        {admin && trial.status !== "paid" ? (
          <>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconKey />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <label htmlFor={codeId}>{t("Unlock code")}</label>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {t(
                    "From BlackArk, to extend the trial, end it, or turn it into a paid plan. Each code works once.",
                  )}
                </ItemDescription>
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!code.trim()) return;
                    unlock.mutate(code, { onSuccess: () => setCode("") });
                  }}
                >
                  <Input
                    autoComplete="off"
                    className="font-mono text-xs"
                    id={codeId}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="ARK1-…"
                    spellCheck={false}
                    value={code}
                  />
                  <Button
                    disabled={unlock.isPending || !code.trim()}
                    size="sm"
                    type="submit"
                  >
                    {unlock.isPending ? t("Checking…") : t("Use code")}
                  </Button>
                </form>
                {unlock.error ? (
                  <p className="mt-2 text-destructive text-sm" role="alert">
                    {unlock.error.message}
                  </p>
                ) : unlock.data ? (
                  <p className="mt-2 text-sm" role="status">
                    {unlock.data.action === "paid"
                      ? t("Done. The trial is now a paid plan.")
                      : unlock.data.action === "end"
                        ? t("Done. The trial has ended.")
                        : t("Done. The trial now ends on {end}.", {
                            end: day(unlock.data.trial.endsAt),
                          })}
                  </p>
                ) : null}
              </ItemContent>
            </Item>
          </>
        ) : null}
      </PageRows>
    </PageSection>
  );
}
