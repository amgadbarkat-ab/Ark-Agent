import { MutationObserver, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { isIosApp } from "@/lib/store-app";
import { queryClient } from "@/query-client";
import { exchangeNativeSignInMutationOptions } from "./mutations";
import {
  browserPendingStore,
  type Grant,
  grantFrom,
  type PendingStore,
} from "./sign-in";

/** Where a failed sign-in is sent to say so. The sign-in screen reads it. */
export const FAILED_PATH = "/sign?native=failed";

export type CompleteDeps = {
  store: PendingStore;
  exchange: (grant: Grant) => Promise<void>;
  closeBrowser: () => Promise<void>;
  go: (path: string) => void;
  now: () => number;
};

/**
 * Act on an address the app was opened with.
 *
 * "ignored" is anything that is not the answer to the sign-in this app started (see `grantFrom`), and
 * leaves everything as it was. Otherwise the secret is spent first, whatever follows, so one answer
 * is one try; then the code is exchanged, the browser closed, and the app sent home (signed in) or to
 * the sign-in screen with the reason (not).
 */
export async function completeNativeSignIn(
  address: string,
  scheme: string,
  deps: CompleteDeps,
): Promise<"ignored" | "signed-in" | "failed"> {
  const grant = grantFrom(address, scheme, deps.store.read(), deps.now());
  if (!grant) return "ignored";
  deps.store.clear();
  let outcome: "signed-in" | "failed" = "signed-in";
  try {
    await deps.exchange(grant);
  } catch {
    outcome = "failed";
  }
  await deps.closeBrowser().catch(() => undefined);
  deps.go(outcome === "signed-in" ? "/" : FAILED_PATH);
  return outcome;
}

/**
 * Finish a sign-in when the system browser opens the app again.
 *
 * Mounted once at the root, because the answer arrives whichever screen the app is on, including
 * when the phone had unloaded it while the browser was open (then it arrives as the address the app
 * was launched with). Does nothing anywhere but the iOS app, and nothing until the server has said
 * which scheme the app is opened by.
 */
export function useNativeSignInReturn() {
  // Asked only inside the iOS app: nowhere else has an answer to wait for.
  const capabilities = useQuery({
    ...deploymentCapabilitiesQueryOptions(),
    enabled: isIosApp(),
  });
  const scheme = capabilities.data?.appUrlScheme ?? null;

  useEffect(() => {
    if (!isIosApp() || !scheme) return;
    let cancelled = false;
    let stop: (() => void) | undefined;

    const deps: CompleteDeps = {
      store: browserPendingStore,
      exchange: (grant) =>
        new MutationObserver(
          queryClient,
          exchangeNativeSignInMutationOptions(queryClient),
        ).mutate(grant),
      closeBrowser: async () => {
        const { Browser } = await import("@capacitor/browser");
        await Browser.close();
      },
      go: (path) => window.location.assign(path),
      now: Date.now,
    };

    (async () => {
      const { App } = await import("@capacitor/app");
      const listener = await App.addListener("appUrlOpen", (event) => {
        void completeNativeSignIn(event.url, scheme, deps);
      });
      if (cancelled) {
        await listener.remove();
        return;
      }
      stop = () => void listener.remove();
      const launch = await App.getLaunchUrl();
      if (launch?.url) await completeNativeSignIn(launch.url, scheme, deps);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [scheme]);
}

/** Open the system browser at the server's sign-in page. */
export async function openSystemBrowser(address: string): Promise<void> {
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url: address });
}
