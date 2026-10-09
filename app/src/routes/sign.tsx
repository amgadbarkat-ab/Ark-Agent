import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import { openSystemBrowser } from "@/lib/native/listener";
import { beginNativeSignIn, NATIVE_PROVIDERS } from "@/lib/native/sign-in";
import { isIosApp } from "@/lib/store-app";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  // Set when the iOS app was opened with an answer from the system browser that did not work.
  validateSearch: (search: Record<string, unknown>): { native?: "failed" } =>
    search.native === "failed" ? { native: "failed" } : {},
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

function SignScreen() {
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const search = Route.useSearch();
  /*
   * Inside the iOS app sign-in happens in the system browser, because Google refuses an embedded web
   * view (lib/native/sign-in.ts). Only the providers that page can start are offered there, and the
   * company-address form is not: both need a way back into the app that does not exist for them yet.
   */
  const inIosApp = isIosApp();
  const capabilities = useQuery({
    ...deploymentCapabilitiesQueryOptions(),
    enabled: inIosApp,
  });
  const appUrlScheme = capabilities.data?.appUrlScheme ?? null;
  const allProviders = options?.providers ?? [];
  const providers = inIosApp
    ? allProviders.filter((provider) =>
        (NATIVE_PROVIDERS as readonly string[]).includes(provider),
      )
    : allProviders;
  const showCompanySignIn = Boolean(options?.sso) && !inIosApp;
  const [email, setEmail] = useState("");

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("sso");

    try {
      await signInWithEmailDomain(email);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No identity provider is registered for that address.",
      );
      setOpening(null);
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);

    try {
      if (inIosApp) {
        if (
          !appUrlScheme ||
          !(NATIVE_PROVIDERS as readonly string[]).includes(provider)
        ) {
          throw new Error("Signing in is not set up in this app yet.");
        }
        await beginNativeSignIn({
          provider: provider as (typeof NATIVE_PROVIDERS)[number],
          scheme: appUrlScheme,
          origin: window.location.origin,
          open: openSystemBrowser,
        });
        // The browser is open over this screen. Coming back to it, the buttons work again.
        setOpening(null);
        return;
      }
      await signInWith(provider);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Could not start ${providerName(provider)} sign-in.`,
      );
      setOpening(null);
    }
  }

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <AgentOrb size="56px" />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          Sign in to {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {providers.length > 0 ? (
            <div className="flex flex-col gap-2">
              {providers.map((provider) => (
                /*
                 * Every provider gets the same button, and it is the light-themed outline one
                 * rather than the app's filled primary. Google's guidelines require their button be
                 * at least as prominent as any other sign-in option and specify its fill and
                 * stroke, so making one provider the loud one would break that for the others. The
                 * same size and weight throughout is also the honest presentation: a deployment
                 * that configured three has three, and none of them is the recommended one.
                 */
                <Button
                  className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
                  disabled={opening !== null}
                  key={provider}
                  onClick={() => handleSignIn(provider)}
                  size="lg"
                  variant="outline"
                >
                  <ProviderLogo provider={provider} />
                  {/* Centred against the button, not against the space left of the mark. */}
                  <span className="flex-1 text-center">
                    {opening === provider
                      ? `Opening ${providerName(provider)}…`
                      : `Continue with ${providerName(provider)}`}
                  </span>
                  {/* Balances the mark so the label sits in the middle of the button. */}
                  <span aria-hidden="true" className="size-[18px]" />
                </Button>
              ))}
            </div>
          ) : showCompanySignIn ? null : (
            <p className="text-center text-sm text-muted-foreground">
              {inIosApp
                ? "Signing in with this account type is not available in the app."
                : "No sign-in provider is configured for this deployment."}
            </p>
          )}
          {/*
           * The way in for a company that runs its own identity provider.
           *
           * Below the buttons, because a deployment with both has more people arriving through the
           * buttons: the registered providers are for the companies whose IdP was added by hand.
           */}
          {showCompanySignIn ? (
            <form className="mt-3" onSubmit={handleDomainSignIn}>
              {providers.length > 0 ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">or</span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              <Input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
              <Button
                className="mt-2 h-10 w-full tracking-tight"
                disabled={opening !== null || email.trim().length === 0}
                size="lg"
                type="submit"
                variant="outline"
              >
                {opening === "sso"
                  ? "Opening…"
                  : "Continue with your company account"}
              </Button>
            </form>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : search.native === "failed" ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              Signing in did not finish. Please try again.
            </p>
          ) : null}
        </motion.div>
        {/*
         * Where the terms and the privacy notice are, before anyone signs up. Acceptance is asked for
         * after sign-in (the terms screen), by an act of ticking; this is the notice that it will be.
         */}
        <motion.p
          className="mt-6 text-center text-muted-foreground text-xs"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          By continuing you will be asked to agree to the{" "}
          <a className="underline underline-offset-4" href="/terms">
            terms of service
          </a>
          . How we handle your data is in the{" "}
          <a className="underline underline-offset-4" href="/privacy">
            privacy notice
          </a>
          .
        </motion.p>
      </motion.div>
    </div>
  );
}
