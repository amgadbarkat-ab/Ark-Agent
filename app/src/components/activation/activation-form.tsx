/**
 * The one box that activates ArkAgent on this computer (#109, v0.1.42), on the Activate screen and
 * on Settings, then Plan: a trial activation code, a paid licence key, or an unlock code, and the
 * trial setup file that DT Lab imports in the setup session.
 */
import { IconFileImport, IconKey } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateLocale, useT } from "@/lib/i18n";
import {
  applyActivationCodeMutationOptions,
  importTrialProfileMutationOptions,
} from "@/lib/trial/mutations";
import { type Activation, activationQueryOptions } from "@/lib/trial/queries";
import { queryClient } from "@/query-client";

export function activationDay(iso: string): string {
  return new Date(iso).toLocaleDateString(dateLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** One line on where this install stands. */
export function useActivationLine() {
  const t = useT();
  return (activation: Activation): string => {
    const until = activation.until ? activationDay(activation.until) : "";
    switch (activation.state) {
      case "paid":
        return activation.until
          ? t("Paid licence, valid until {date}.", { date: until })
          : t("Paid. No end date.");
      case "trial":
        return activation.daysLeft === 1
          ? t("Trial until {date}. 1 day left.", { date: until })
          : t("Trial until {date}. {days} days left.", {
              date: until,
              days: activation.daysLeft ?? 0,
            });
      case "ended":
        return t(
          "The trial ended on {date}. Your conversations and settings are kept.",
          { date: until },
        );
      case "expired":
        return t(
          "The licence ended on {date}. Your conversations and settings are kept.",
          { date: until },
        );
      default:
        return t("ArkAgent is not activated on this computer yet.");
    }
  };
}

export function ActivationForm({
  onActivated,
  showFileImport = true,
}: {
  onActivated?: (activation: Activation) => void;
  showFileImport?: boolean;
}) {
  const t = useT();
  const apply = useMutation(applyActivationCodeMutationOptions(queryClient));
  const importProfile = useMutation(
    importTrialProfileMutationOptions(queryClient),
  );
  const [code, setCode] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const codeId = useId();

  const done = apply.data
    ? apply.data.kind === "license"
      ? apply.data.changed
        ? t("Done. Your paid licence is active.")
        : t("This licence key is already in use here. Nothing changed.")
      : apply.data.kind === "trial"
        ? apply.data.changed
          ? t("Done. Your trial is active.")
          : t("This trial code is already in use here. Nothing changed.")
        : apply.data.kind === "paid"
          ? t("Done. The trial is now a paid plan.")
          : apply.data.kind === "end"
            ? t("Done. The trial has ended.")
            : t("Done. The trial now ends on {end}.", {
                end: activationDay(apply.data.activation.until ?? ""),
              })
    : null;

  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!code.trim()) return;
          apply.mutate(code, {
            onSuccess: (result) => {
              setCode("");
              if (result.activation.allowed) onActivated?.(result.activation);
            },
          });
        }}
      >
        <label className="flex items-center gap-2 text-sm" htmlFor={codeId}>
          <IconKey className="size-4" />
          {t("Trial activation code or licence key")}
        </label>
        <div className="flex gap-2">
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
            disabled={apply.isPending || !code.trim()}
            size="sm"
            type="submit"
          >
            {apply.isPending ? t("Checking…") : t("Activate")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {t(
            "BlackArk gives you a trial activation code for a trial. After you pay, your licence key arrives by email; renewals come in by themselves.",
          )}
        </p>
        {apply.error ? (
          <p className="text-destructive text-sm" role="alert">
            {apply.error.message}
          </p>
        ) : done ? (
          <p className="text-sm" role="status">
            {done}
          </p>
        ) : null}
      </form>
      {showFileImport ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-sm">
              <IconFileImport className="size-4" />
              {t("Trial setup file (.arktrial)")}
            </span>
            <input
              accept=".arktrial,application/json"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                importProfile.mutate(await file.text(), {
                  onSuccess: async () => {
                    const activation = await queryClient.fetchQuery(
                      activationQueryOptions(),
                    );
                    if (activation?.allowed) onActivated?.(activation);
                  },
                });
              }}
              ref={fileInput}
              type="file"
            />
            <Button
              disabled={importProfile.isPending}
              onClick={() => fileInput.current?.click()}
              size="sm"
              variant="outline"
            >
              {importProfile.isPending ? t("Importing…") : t("Choose file")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t(
              "Used in the trial setup session: it sets up the trial and the trial employees.",
            )}
          </p>
          {importProfile.error ? (
            <p className="text-destructive text-sm" role="alert">
              {importProfile.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
