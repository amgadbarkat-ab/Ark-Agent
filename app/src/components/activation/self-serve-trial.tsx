/**
 * The free trial, started from the Activate screen with nothing else to do (v0.1.58; Amgad, 26 Nov
 * 2026: "the full journey must be automated"). The administrator writes their name, company and
 * email; blackark.uk emails a 6-digit code; typing it starts 7 days of Ark Team on this computer.
 * Shown only where blackark.uk can sign such trials and nothing is activated yet.
 */
import { IconMail, IconSparkles } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage, useT } from "@/lib/i18n";
import {
  confirmSelfServeTrialMutationOptions,
  startSelfServeTrialMutationOptions,
} from "@/lib/trial/mutations";
import type { Activation } from "@/lib/trial/queries";
import { queryClient } from "@/query-client";

export function SelfServeTrial({
  activation,
  onActivated,
}: {
  activation: Activation;
  onActivated?: (activation: Activation) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const start = useMutation(startSelfServeTrialMutationOptions());
  const confirm = useMutation(
    confirmSelfServeTrialMutationOptions(queryClient),
  );
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const ids = {
    name: useId(),
    company: useId(),
    email: useId(),
    code: useId(),
  };

  if (!activation.selfServeTrial) return null;

  if (sentTo) {
    return (
      <form
        className="flex w-full flex-col gap-2 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^\d{6}$/.test(code.trim())) return;
          confirm.mutate(
            { email: sentTo, code: code.trim() },
            {
              onSuccess: (result) => {
                if (result.activation.allowed) onActivated?.(result.activation);
              },
            },
          );
        }}
      >
        <label className="flex items-center gap-2 text-sm" htmlFor={ids.code}>
          <IconMail className="size-4" />
          {t("The 6-digit code we sent to {email}", { email: sentTo })}
        </label>
        <div className="flex gap-2">
          <Input
            autoComplete="one-time-code"
            className="font-mono tracking-widest"
            id={ids.code}
            inputMode="numeric"
            maxLength={6}
            onChange={(event) => setCode(event.target.value)}
            placeholder="123456"
            value={code}
          />
          <Button
            disabled={confirm.isPending || !/^\d{6}$/.test(code.trim())}
            size="sm"
            type="submit"
          >
            {confirm.isPending ? t("Checking…") : t("Start my trial")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {t(
            "The code works for 15 minutes. Not there? Check your spam folder, or ask for a new one.",
          )}
        </p>
        {confirm.error ? (
          <p className="text-destructive text-sm" role="alert">
            {confirm.error.message}
          </p>
        ) : null}
        <Button
          onClick={() => {
            setSentTo(null);
            setCode("");
            confirm.reset();
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Ask for a new code")}
        </Button>
      </form>
    );
  }

  const ready = name.trim() && company.trim() && email.includes("@");
  return (
    <form
      className="flex w-full flex-col gap-3 rounded-lg border p-4 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        const to = email.trim().toLowerCase();
        start.mutate(
          {
            name: name.trim(),
            company: company.trim(),
            email: to,
            language,
          },
          { onSuccess: () => setSentTo(to) },
        );
      }}
    >
      <div className="flex items-center gap-2 font-medium text-sm">
        <IconSparkles className="size-4" />
        {t("Start a free 7-day trial")}
      </div>
      <p className="text-muted-foreground text-xs">
        {t(
          "Ark Team with 5 digital employees per person, free for 7 days. No card needed. We email you a code to check the address.",
        )}
      </p>
      <label className="flex flex-col gap-1 text-sm" htmlFor={ids.name}>
        {t("Your name")}
        <Input
          autoComplete="name"
          id={ids.name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={ids.company}>
        {t("Company")}
        <Input
          autoComplete="organization"
          id={ids.company}
          maxLength={120}
          onChange={(event) => setCompany(event.target.value)}
          value={company}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm" htmlFor={ids.email}>
        {t("Email")}
        <Input
          autoComplete="email"
          id={ids.email}
          maxLength={200}
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
      </label>
      <Button disabled={start.isPending || !ready} size="sm" type="submit">
        {start.isPending ? t("Sending…") : t("Email me a code")}
      </Button>
      {start.error ? (
        <p className="text-destructive text-sm" role="alert">
          {start.error.message}
        </p>
      ) : null}
    </form>
  );
}
