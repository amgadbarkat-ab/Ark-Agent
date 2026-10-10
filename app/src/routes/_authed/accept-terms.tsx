import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArkAgentPortrait } from "@/components/brand/arkagent-portrait";
import { Button } from "@/components/ui/button";
import {
  acceptTermsMutationOptions,
  signOutMutationOptions,
} from "@/lib/auth/mutations";
import { currentUserQueryOptions, needsTerms } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { queryClient } from "@/query-client";

/**
 * The one screen somebody can see before they have accepted the terms.
 *
 * It names the version on screen and sends it back, so the server records agreement to the text this
 * person was shown and refuses if that has changed since. The terms themselves open in their own page
 * (a new tab, so nobody loses this one), and the button stays off until the box is ticked: acceptance
 * is an act, not a default.
 */
export const Route = createFileRoute("/_authed/accept-terms")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    // Somebody who has accepted, or who is not asked, has no business here.
    if (!user || !needsTerms(user)) {
      throw redirect({ to: "/" });
    }
  },
  component: AcceptTerms,
});

function AcceptTerms() {
  const navigate = useNavigate();
  const { data: user } = useQuery(currentUserQueryOptions());
  const [agreed, setAgreed] = useState(false);
  const accept = useMutation(acceptTermsMutationOptions(queryClient));
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const version = user?.terms?.version;

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <ArkAgentPortrait size={56} />
        <h1 className="text-2xl font-medium tracking-tight">
          Before you start
        </h1>
        <p className="text-sm text-muted-foreground">
          To use {appConfig.brand.productName} you need to agree to the terms of
          service. They are short enough to read, and they explain what the
          digital employees do on your behalf and what we do with your data.
        </p>
        <p className="text-sm">
          <a
            className="underline underline-offset-4"
            href="/terms"
            rel="noreferrer"
            target="_blank"
          >
            Read the terms of service
          </a>
          {" · "}
          <a
            className="underline underline-offset-4"
            href="/privacy"
            rel="noreferrer"
            target="_blank"
          >
            Privacy notice
          </a>
        </p>
        <label className="flex items-start gap-2 text-left text-sm">
          <input
            checked={agreed}
            className="mt-1"
            onChange={(event) => setAgreed(event.target.checked)}
            type="checkbox"
          />
          <span>
            I have read the terms of service and I agree to them
            {version ? ` (version ${version})` : ""}.
          </span>
        </label>
        <Button
          className="h-10 w-full"
          disabled={!agreed || !version || accept.isPending}
          onClick={async () => {
            if (!version) return;
            try {
              await accept.mutateAsync(version);
            } catch {
              // Shown below; staying here is the right answer to a refusal.
              return;
            }
            // The refetch has finished by now, so the gate sees the answer rather than the old one.
            await navigate({ to: "/" });
          }}
          size="lg"
        >
          {accept.isPending ? "Saving…" : "Agree and continue"}
        </Button>
        {accept.error ? (
          <p className="text-sm text-destructive" role="alert">
            {accept.error.message}
          </p>
        ) : null}
        <button
          className="text-xs text-muted-foreground underline underline-offset-4"
          disabled={signOut.isPending}
          onClick={async () => {
            await signOut.mutateAsync();
            await navigate({ to: "/sign" });
          }}
          type="button"
        >
          Not you? Sign out
        </button>
      </div>
    </div>
  );
}
