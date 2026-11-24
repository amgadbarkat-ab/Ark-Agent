import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { authKeys, takeSignInNotice } from "@/lib/auth/queries";
import { tryClient } from "@/lib/client";
import { sentenceNow, useT } from "@/lib/i18n";
import { queryClient } from "@/query-client";

/**
 * Signing in as yourself, on every computer (Amgad, 24 Nov 2026): the company's administrator and each
 * staff sub-profile have their own email and password. On a fresh ArkAgent, the first person makes
 * the administrator's account here.
 */
export function PasswordSignIn() {
  const t = useT();
  const navigate = useNavigate();
  const setup = useQuery({
    queryKey: ["team", "setup"],
    queryFn: async (): Promise<boolean> => {
      const response = await tryClient("/api/team/setup").catch(() => null);
      if (response?.status !== 200) return false;
      return ((await response.json()) as { needed: boolean }).needed;
    },
  });
  const [notice] = useState(() => sentenceNow(takeSignInNotice()));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  const making = setup.data === true;

  async function signIn() {
    const result = await authClient.signIn
      .email({ email, password })
      .catch(() => null);
    if (!result) {
      setError(t("Signing in did not work. Try again."));
      return;
    }
    if (result.error) {
      setError(t("That email and password do not match."));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: authKeys.currentUser() });
    await navigate({ to: "/" });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (making && password !== again) {
      setError(t("The two passwords are not the same."));
      return;
    }
    setBusy(true);
    try {
      if (making) {
        const response = await tryClient("/api/team/setup", {
          method: "POST",
          body: { name, email, password },
        });
        if (response.status !== 201) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setError(
            body?.error
              ? sentenceNow(body.error)
              : t("The account could not be made."),
          );
          return;
        }
      }
      await signIn();
    } finally {
      setBusy(false);
    }
  }

  if (setup.isPending) return null;
  return (
    <form className="flex w-full flex-col gap-3" onSubmit={submit}>
      {making ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Make the administrator's account for this ArkAgent. The administrator adds the rest of the team later.",
          )}
        </p>
      ) : null}
      {making ? (
        <Field>
          <FieldLabel htmlFor="team-name">{t("Your name")}</FieldLabel>
          <Input
            autoComplete="name"
            id="team-name"
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="team-email">{t("Email")}</FieldLabel>
        <Input
          autoComplete="email"
          id="team-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="team-password">{t("Password")}</FieldLabel>
        <Input
          autoComplete={making ? "new-password" : "current-password"}
          id="team-password"
          minLength={making ? 10 : undefined}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </Field>
      {making ? (
        <Field>
          <FieldLabel htmlFor="team-password-again">
            {t("The password again")}
          </FieldLabel>
          <Input
            autoComplete="new-password"
            id="team-password-again"
            minLength={10}
            onChange={(event) => setAgain(event.target.value)}
            required
            type="password"
            value={again}
          />
        </Field>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={busy} type="submit">
        {making ? t("Make the account and sign in") : t("Sign in")}
      </Button>
    </form>
  );
}
