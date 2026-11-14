/**
 * The customer trial on this install (#109), on Settings, then Plan: whose it is, until when, how
 * many days are left, and the two things an administrator can do here, import the trial profile
 * BlackArk sent and enter an unlock code.
 *
 * Shown to everybody when there is a trial; the import row only to an administrator, so a deployment
 * with no trial does not offer anybody else something they cannot use.
 */
import { IconCalendarTime, IconFileImport, IconKey } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { dateLocale, useT } from "@/lib/i18n";
import {
  applyUnlockCodeMutationOptions,
  importTrialProfileMutationOptions,
} from "@/lib/trial/mutations";
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
  const importProfile = useMutation(
    importTrialProfileMutationOptions(queryClient),
  );
  const unlock = useMutation(applyUnlockCodeMutationOptions(queryClient));
  const [code, setCode] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const codeId = useId();

  const trial = overview.data?.trial ?? null;
  if (overview.isPending || overview.error) return null;
  if (!trial && !admin) return null;

  const { period, state } = trial ? lines(trial) : { period: "", state: "" };

  return (
    <PageSection
      description={
        trial
          ? t("Trial for {customer}, set by BlackArk.", {
              customer: trial.customerName,
            })
          : t(
              "If BlackArk sent you a trial profile (a file ending in .arktrial), import it here.",
            )
      }
      title={t("Trial")}
    >
      <PageRows>
        {trial ? (
          <>
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
                              when: new Date(
                                trial.lastCheckInAt,
                              ).toLocaleString(dateLocale()),
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
          </>
        ) : null}
        {admin ? (
          <>
            {trial ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconFileImport />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("Import trial profile")}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {overview.data?.keyConfigured === false
                    ? t(
                        "This version of ArkAgent has no BlackArk key yet, so it cannot check a trial profile or code. Ask BlackArk for the current version.",
                      )
                    : trial
                      ? t(
                          "Only a newer profile for {customer} can replace this one.",
                          { customer: trial.customerName },
                        )
                      : t(
                          "The trial employees are set up as soon as it is imported.",
                        )}
                </ItemDescription>
                {importProfile.error ? (
                  <p className="mt-2 text-destructive text-sm" role="alert">
                    {importProfile.error.message}
                  </p>
                ) : importProfile.data ? (
                  <p className="mt-2 text-sm" role="status">
                    {importProfile.data.changed
                      ? t(
                          "Imported. The trial employees are on your Digital Team.",
                        )
                      : t(
                          "This profile was already imported. Nothing changed.",
                        )}
                  </p>
                ) : null}
              </ItemContent>
              <ItemActions>
                <input
                  accept=".arktrial,application/json"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    importProfile.mutate(await file.text());
                  }}
                  ref={fileInput}
                  type="file"
                />
                <Button
                  disabled={
                    importProfile.isPending ||
                    overview.data?.keyConfigured === false
                  }
                  onClick={() => fileInput.current?.click()}
                  size="sm"
                  variant="outline"
                >
                  {importProfile.isPending ? t("Importing…") : t("Choose file")}
                </Button>
              </ItemActions>
            </Item>
          </>
        ) : null}
      </PageRows>
    </PageSection>
  );
}
