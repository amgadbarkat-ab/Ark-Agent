/**
 * ArkAgent's own OAuth apps, used when an administrator has not registered one (desk #83).
 *
 * WHY. Gmail, Google Drive and Microsoft 365 are reached as the person asking, which needs an OAuth
 * client: an app registered with Google or Microsoft. On a company server an administrator
 * registers their own and pastes it in, and that stays the way to do it. On ArkAgent Desktop it
 * meant every person creating a Google Cloud project or an Azure app before Connect did anything.
 * Amgad asked for the usual desktop answer instead: apps registered once, by ArkAgent's publisher
 * (ZEUS FINANCIAL MONOPROSOPI I.K.E.), shipped in the desktop build, with a localhost redirect.
 *
 * WHAT THEY ARE. Clients of the kind both vendors define for software that runs on a person's own
 * computer, where nothing shipped in it can be kept secret:
 *  - Google: a "Desktop app" client. Its secret is sent, and Google documents that it is not
 *    treated as a secret for this client type. Proof of the request is PKCE, which every consent
 *    here already uses.
 *  - Microsoft: a public client ("mobile and desktop"), which has no secret at all. The token
 *    request goes without one; `oauth.ts` sends a secret only when there is one.
 *
 * WHAT THEY ARE NOT. A way round an administrator. A client an administrator registered for a
 * server always wins, and a server still has to be added on the Plugins page before anybody can
 * connect it: this answers "which app", never "is this vendor allowed here".
 *
 * Read from the environment, which the desktop fills from its build. Unset is the normal state of a
 * hosted deployment, and then nothing here changes anything.
 */
import { catalogueEntry } from "./catalogue";
import type { OAuthClient } from "./store";

export type BuiltinOAuthClients = {
  google?: OAuthClient;
  microsoft?: OAuthClient;
};

type Environment = Record<string, string | undefined>;

function value(environment: Environment, name: string): string | undefined {
  const text = environment[name]?.trim();
  return text ? text : undefined;
}

/** The clients the environment names. A vendor with no client id has none. */
export function builtinOAuthClientsFrom(
  environment: Environment,
): BuiltinOAuthClients {
  const clients: BuiltinOAuthClients = {};
  const googleId = value(environment, "ARKAGENT_GOOGLE_OAUTH_CLIENT_ID");
  if (googleId) {
    clients.google = {
      clientId: googleId,
      clientSecret:
        value(environment, "ARKAGENT_GOOGLE_OAUTH_CLIENT_SECRET") ?? "",
    };
  }
  const microsoftId = value(environment, "ARKAGENT_MICROSOFT_OAUTH_CLIENT_ID");
  if (microsoftId) {
    // A public client: no secret, by design. See the note at the top.
    clients.microsoft = { clientId: microsoftId, clientSecret: "" };
  }
  return clients;
}

/**
 * The built-in client for a catalogue entry, or null.
 *
 * Only for entries an administrator would otherwise register a client for by hand: a vendor that
 * registers this deployment itself (Notion) needs none, and a server added by URL is nobody's
 * built-in app.
 */
export function builtinOAuthClientFor(
  serverId: string,
  clients: BuiltinOAuthClients,
): OAuthClient | null {
  const entry = catalogueEntry(serverId);
  if (entry?.auth.kind !== "user-oauth") return null;
  if (entry.auth.clientRegistration === "dynamic") return null;
  if (entry.vendor === "Google") return clients.google ?? null;
  if (entry.vendor === "Microsoft") return clients.microsoft ?? null;
  return null;
}
