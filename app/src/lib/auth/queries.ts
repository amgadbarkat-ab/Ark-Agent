import { authClient } from "./client";
import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * Where this person is in first-run onboarding.
 *
 * On the user rather than its own query, so the `_authed` gate learns it from the request it
 * already makes. A null `completedAt` is what sends the app to /onboarding.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

/**
 * Where this person stands against the terms of service in force.
 *
 * `required` is the server's decision (the deployment asks, and this person is a customer rather than
 * staff), so the app never works it out from anything else.
 */
export type TermsStatus = {
  version: string;
  required: boolean;
  acceptedAt: string | null;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: "admin" | "user";
  /** Null means this deployment does not track onboarding, which reads as nothing to finish. */
  onboarding: OnboardingStatus | null;
  /** Null means this deployment does not record acceptance, which reads as nothing to accept. */
  terms: TermsStatus | null;
};

/** Whether the gate holds: the terms are required and this person has not accepted this version. */
export function needsTerms(user: AuthenticatedUser): boolean {
  // `?.` because a server that predates this field (a rolling update) sends none, and that reads as
  // nothing to accept rather than as a screen that cannot draw.
  return user.terms?.required === true && user.terms.acceptedAt === null;
}

/** Whether the gate holds: there is an onboarding to do and this person has not finished it. */
export function needsOnboarding(user: AuthenticatedUser): boolean {
  return user.onboarding !== null && user.onboarding.completedAt === null;
}

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};

/** An identity provider this deployment can sign somebody in with. */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** What the sign-in screen may offer, answered by the process that knows. */
export type SignInOptions = {
  providers: AuthProviderId[];
  /**
   * Whether any enterprise identity provider is registered.
   *
   * A boolean, not a list: naming them would tell anybody who loads the sign-in page which companies
   * use this deployment, before they have signed in.
   */
  sso: boolean;
  /** A customer's team signs in with email and password (ArkAgent): the form, not provider buttons. */
  password: boolean;
};

async function signInOptions(): Promise<SignInOptions> {
  // The whole body, so both fields arrive together. Reading a field off the Response `client`
  // returns without a key quietly yields undefined: the screen would say no provider is configured
  // while the server was saying it has one.
  const body = (await (
    await client("/api/capabilities", { fallback: "Could not load sign-in" })
  ).json()) as {
    authProviders?: AuthProviderId[];
    ssoConfigured?: boolean;
    passwordSignIn?: boolean;
  };

  return {
    providers: body.authProviders ?? [],
    sso: body.ssoConfigured === true,
    password: body.passwordSignIn === true,
  };
}

/**
 * Which providers the sign-in screen may offer.
 *
 * From the server rather than from the build. The image is built once with no deployment
 * environment, so a list compiled into the bundle can only ever describe the build machine.
 */
export function authProvidersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers(),
    queryFn: signInOptions,
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function currentUser(): Promise<AuthenticatedUser | null> {
  /*
   * `tryClient` rather than `client`: not being signed in is an answer here, not a failure, and it
   * arrives as a 401 that has to be read before anything decides the request went wrong.
   */
  const response = await tryClient("/api/me");
  if (response.status === 401) {
    return null;
  }
  if (response.status === 403) {
    // A team sub-profile that is not paid for (yet), suspended or removed: signed out, and the
    // sign-in screen says why (accounts/team.ts on the server).
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
    } | null;
    if (body?.code === "subprofile_inactive") {
      rememberSignInNotice(body.error ?? "");
      await authClient.signOut().catch(() => undefined);
      return null;
    }
  }
  if (!response.ok) {
    throw new Error(`Could not load the current user (${response.status})`);
  }

  const body = (await response.json()) as { user: AuthenticatedUser };
  return body.user;
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
  });
}

const NOTICE_KEY = "ark.signin.notice";

/** A sentence for the sign-in screen, kept across the redirect to it. */
export function rememberSignInNotice(text: string) {
  try {
    sessionStorage.setItem(NOTICE_KEY, text);
  } catch {
    // Private windows: the screen simply says nothing.
  }
}

export function takeSignInNotice(): string | null {
  try {
    const text = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return text;
  } catch {
    return null;
  }
}
