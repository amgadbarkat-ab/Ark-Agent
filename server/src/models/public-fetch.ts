/**
 * The fetch a sub-profile's model calls go through (v0.1.57; the security review of v0.1.56).
 *
 * A sub-profile works from another computer, so a model address that reaches the administrator's
 * computer or office network would be theirs to read. Saving a connection already refuses such an
 * address (models/routes.ts, F4), but a public name can be pointed somewhere else after it was saved.
 * So on EVERY call, and on every redirect:
 * - the address must be public: names are resolved and every answer must be public
 *   (`createAgentFetch` with private hosts off, `isInternalAddress`);
 * - it must be https. A name re-pointed between that look-up and the connection (DNS rebinding)
 *   then reaches a host that cannot show a certificate for the name, and the connection fails.
 *   This is the pin: the certificate, not the address.
 */
import { createAgentFetch, EndpointNotAllowedError } from "../agents/endpoint";

export type GuardedFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export const HTTPS_ONLY_FOR_SUBPROFILE =
  "A sub-profile's model must be reached over https. Choose a hosted provider, or ask the administrator.";

export function createPublicModelFetch(
  options: {
    fetchImpl?: typeof fetch;
    resolve?: (hostname: string) => Promise<string[]>;
    onRefusal?: (refusal: { address: string; reason: string }) => void;
  } = {},
): GuardedFetch {
  const underlying = options.fetchImpl ?? fetch;
  // Every hop passes through here, the first and each redirect, so none of them can be http.
  const httpsOnly = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") {
      throw new EndpointNotAllowedError(HTTPS_ONLY_FOR_SUBPROFILE);
    }
    return underlying(input, init);
  }) as typeof fetch;
  return createAgentFetch({
    allowPrivateHosts: false,
    fetchImpl: httpsOnly,
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.onRefusal ? { onRefusal: options.onRefusal } : {}),
  });
}

/**
 * The fetch for one person's model calls: the public one for a sub-profile, the deployment's own
 * for everybody else. A failure to tell is a sub-profile.
 */
export function modelFetchFor(options: {
  standard: GuardedFetch;
  publicOnly: GuardedFetch;
  isSubprofile?: (actorId: string) => Promise<boolean>;
}): (actorId: string) => Promise<GuardedFetch> {
  return async (actorId) => {
    if (!options.isSubprofile) return options.standard;
    const restricted = await options.isSubprofile(actorId).catch(() => true);
    return restricted ? options.publicOnly : options.standard;
  };
}
