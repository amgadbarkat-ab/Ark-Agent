import { eq } from "drizzle-orm";
import { namesNoDirectory } from "../config";
import type { Database } from "../db/client";
import { accounts, ssoProviders, users } from "../db/schema";

/**
 * Which ways of signing in can vouch for the address they hand us.
 *
 * Everything this deployment decides about a person is keyed on their address, and for one decision
 * that is dangerous: who is an administrator. The role is granted to an address named in
 * `INITIAL_ADMIN_EMAILS`, so it matters enormously where the address came from.
 *
 * - A **multi-tenant Microsoft** sign-in (`common`, `organizations`, `consumers`) takes it from a claim
 *   the signing-in tenant's own administrator writes. Anybody can create a directory and put
 *   `ceo@yourcompany.com` in it, and sign in as that address. This cannot vouch.
 * - A **single-directory Microsoft** sign-in comes from our own directory, where only we write the
 *   claim. It can.
 * - **Google** verifies the address before it sends it, and says so. It can, when it says so.
 * - **Okta** is a single issuer the operator configured. It can.
 * - A **registered company provider** (SAML or OIDC) was put there by an administrator on purpose. It
 *   can.
 * - Anything else is unknown, and unknown cannot vouch.
 *
 * This is about the administrator role only. Anybody may still sign in and be an ordinary customer;
 * the address they present is then just a label, and a false one gets them a separate account with
 * nothing in it.
 */
export type ProviderTrust = {
  /**
   * Whether this person has signed in through something that can vouch for their address, and so may
   * be given the administrator role by the configured list.
   */
  canVouchFor: (userId: string) => Promise<boolean>;
};

export function createProviderTrust(
  database: Database,
  auth: { microsoft?: { tenantId?: string | undefined } | undefined },
): ProviderTrust {
  return {
    async canVouchFor(userId) {
      const [person] = await database
        .select({ verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person) return false;
      const linked = await database
        .select({ providerId: accounts.providerId })
        .from(accounts)
        .where(eq(accounts.userId, userId));
      for (const { providerId } of linked) {
        if (providerId === "google" && person.verified) return true;
        if (
          providerId === "microsoft" &&
          auth.microsoft !== undefined &&
          !namesNoDirectory(auth.microsoft.tenantId)
        ) {
          return true;
        }
        if (providerId === "okta") return true;
        if (providerId === "google" || providerId === "microsoft") continue;
        const [registered] = await database
          .select({ id: ssoProviders.id })
          .from(ssoProviders)
          .where(eq(ssoProviders.providerId, providerId))
          .limit(1);
        if (registered) return true;
      }
      return false;
    },
  };
}
