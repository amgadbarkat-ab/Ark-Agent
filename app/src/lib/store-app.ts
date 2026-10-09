import { useQuery } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

/**
 * Whether this page is open inside one of Ark's store apps, where a way to buy must not appear.
 *
 * Apple and Google take a share of what is sold inside an app and restrict how a subscription may be
 * sold there (docs/ark/19-mobile.md). Ark's answer is a free companion app: signing in, using what
 * the account already has, and nothing that sells, prices or points to somewhere to buy. The same
 * pages are served to everyone, so the app decides at run time, here.
 *
 * Two ways in, and what each is sure of:
 *
 *  - iOS: the shell adds `ArkStoreApp/ios` to the browser's user agent (mobile/ios/capacitor.config.ts).
 *    Nothing else does, so the token alone is enough.
 *  - Android: the app is the site opened in Chrome with no address bar, and what marks it is the
 *    address that opened the page, `android-app://<package name>`. Other Android apps open the site
 *    the same way (the Google app does), so the package has to be Ark's own, which the server says
 *    in `/api/capabilities`. Until it has answered, a page opened by an Android app is treated as
 *    possibly Ark's and shows nothing to buy: no price is ever shown and then taken away.
 *
 * A page opened by nothing special is the website, which sells. This only ever HIDES; it opens
 * nothing up, so a person who fakes it gains nothing and loses the way to buy.
 */

/** What the iOS shell appends to the user agent. */
export const IOS_USER_AGENT_TOKEN = "ArkStoreApp/ios";

/** The one thing kept across the page loads of a visit, so a sign-in round trip cannot forget it. */
const REMEMBERED = "ark.opened-by";

type Source = {
  referrer: string;
  read: () => string | null;
  write: (value: string) => void;
};

/**
 * The Android package that opened this visit, from the referrer of the first page or from earlier in
 * the visit. A visit is one tab: it survives a trip to the identity provider and back, where the
 * referrer is the provider's, and ends with the tab.
 */
export function openedByFrom(source: Source): string | null {
  const match = /^android-app:\/\/([A-Za-z][A-Za-z0-9_.]*)/.exec(
    source.referrer,
  );
  if (match?.[1]) {
    source.write(match[1]);
    return match[1];
  }
  return source.read();
}

/** Whether a way to buy may be shown. Pure, so every combination can be tested. */
export function purchasesAllowedFor(input: {
  userAgent: string;
  /** The Android package that opened this visit, if one did. */
  openedBy: string | null;
  /** Ark's own package, as the server says it; undefined until the server has answered. */
  androidPackage: string | null | undefined;
}): boolean {
  if (input.userAgent.includes(IOS_USER_AGENT_TOKEN)) return false;
  if (input.openedBy === null) return true;
  if (input.androidPackage === undefined) return false;
  return input.androidPackage !== input.openedBy;
}

function browserSource(): Source {
  return {
    referrer: typeof document === "undefined" ? "" : document.referrer,
    read: () => {
      try {
        return window.sessionStorage.getItem(REMEMBERED);
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        window.sessionStorage.setItem(REMEMBERED, value);
      } catch {
        // A browser that will not keep it still has the referrer of this page.
      }
    },
  };
}

let openedBy: string | null | undefined;

/** Read once per page load: the referrer of a page does not change, and a later one is not the opener. */
function openedByThisVisit(): string | null {
  if (openedBy === undefined) openedBy = openedByFrom(browserSource());
  return openedBy;
}

/** For tests, which open many "pages" in one process. */
export function forgetOpener() {
  openedBy = undefined;
}

/**
 * Whether this page may show a way to buy: a price, a plan to choose, billing, a link to either.
 *
 * False inside a store app, and false until it is known not to be one.
 */
export function usePurchasesAllowed(): boolean {
  const opener = openedByThisVisit();
  // Asked only when an Android app opened the page: nobody else needs the answer, and this hook sits
  // inside every link the app draws.
  const capabilities = useQuery(
    { ...deploymentCapabilitiesQueryOptions(), enabled: opener !== null },
    queryClient,
  );
  return purchasesAllowedFor({
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    openedBy: opener,
    androidPackage: capabilities.isSuccess
      ? capabilities.data.androidPackage
      : undefined,
  });
}

/** The page where somebody picks or changes a plan: what a sentence pointing at a purchase links to. */
const PLAN_PATH = "/settings/plan";

/**
 * Whether a link goes to the plan page of this app.
 *
 * Messages written by the server end with their offer to upgrade or to switch something on as one
 * whole link to this page (server/src/accounts/run-gate.ts), so that a store app can leave the
 * sentence out without leaving half of one behind.
 */
export function isPurchaseLink(href: string | undefined): boolean {
  if (!href || typeof window === "undefined") return false;
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin && url.pathname === PLAN_PATH;
  } catch {
    return false;
  }
}
