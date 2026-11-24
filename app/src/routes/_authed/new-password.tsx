import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArkAgentPortrait } from "@/components/brand/arkagent-portrait";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { sentenceNow, useT } from "@/lib/i18n";
import { changePasswordMutationOptions } from "@/lib/team/mutations";
import { teamMeQueryOptions } from "@/lib/team/queries";
import { queryClient } from "@/query-client";

/**
 * A staff sub-profile's first sign-in (Amgad, 24 Nov 2026): the administrator chose the first
 * password, so the person chooses their own before anything else opens.
 */
export const Route = createFileRoute("/_authed/new-password")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient
      .ensureQueryData(teamMeQueryOptions())
      .catch(() => null);
    if (!me?.mustChangePassword) {
      throw redirect({ to: "/" });
    }
  },
  component: NewPassword,
});

function NewPassword() {
  const t = useT();
  const navigate = useNavigate();
  useQuery(teamMeQueryOptions());
  const change = useMutation(changePasswordMutationOptions(queryClient));
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (next !== again) {
      setError(t("The two passwords are not the same."));
      return;
    }
    if (next === current) {
      setError(t("Choose a password that is not the one you were given."));
      return;
    }
    try {
      await change.mutateAsync({ current, next });
      await navigate({ to: "/" });
    } catch (failure) {
      setError(sentenceNow((failure as Error).message));
    }
  }

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center p-6">
      <form className="flex w-full max-w-sm flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col items-center gap-6 text-center">
          <ArkAgentPortrait size={56} />
          <h1 className="text-2xl font-medium tracking-tight">
            {t("Choose your password")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Your administrator gave you a first password. Choose your own now: only you will know it.",
            )}
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="password-current">
            {t("The password you were given")}
          </FieldLabel>
          <Input
            autoComplete="current-password"
            id="password-current"
            onChange={(event) => setCurrent(event.target.value)}
            required
            type="password"
            value={current}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password-next">
            {t("Your new password (at least 10 characters)")}
          </FieldLabel>
          <Input
            autoComplete="new-password"
            id="password-next"
            minLength={10}
            onChange={(event) => setNext(event.target.value)}
            required
            type="password"
            value={next}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password-again">
            {t("The password again")}
          </FieldLabel>
          <Input
            autoComplete="new-password"
            id="password-again"
            minLength={10}
            onChange={(event) => setAgain(event.target.value)}
            required
            type="password"
            value={again}
          />
        </Field>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button disabled={change.isPending} type="submit">
          {t("Save and continue")}
        </Button>
        <Button
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
          type="button"
          variant="ghost"
        >
          {t("Not you? Sign out")}
        </Button>
      </form>
    </div>
  );
}
