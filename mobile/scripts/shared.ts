/**
 * The checks the Android and iOS builds both make of the names a deployment gives them.
 *
 * One place, so the two apps cannot disagree about what a site, a name under the icon or a version is.
 */

export type Environment = Record<string, string | undefined>;

/** `#RRGGBB`. */
export const COLOUR = /^#[0-9A-Fa-f]{6}$/;

/** Letters, digits, spaces and a few marks: it is written into a resource or a plist unescaped. */
export const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .\-_]{0,29}$/u;

export const APP_NAME_RULE =
  "up to 30 letters, digits, spaces, dots, hyphens and underscores, starting with a letter or digit";

export const need = (environment: Environment, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

/** The deployment's address as an origin an Android app can be tied to, or an explanation. */
export function siteFrom(address: string): { url: string; host: string } {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("ARK_APP_URL is not an address.");
  }
  if (url.protocol !== "https:") {
    throw new Error(
      "ARK_APP_URL must be https: an Android app can only be tied to a site served over https.",
    );
  }
  if (url.username || url.password) {
    throw new Error("ARK_APP_URL must not carry a user name or password.");
  }
  if (url.port && url.port !== "443") {
    throw new Error("ARK_APP_URL must use the standard https port.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "ARK_APP_URL is the site itself (https://host), with no path, query or fragment.",
    );
  }
  const host = url.hostname.toLowerCase();
  // An address is not a name the site can be verified under, and `localhost` cannot be reached from a phone.
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) {
    throw new Error(
      "ARK_APP_URL must be a domain name (such as https://ark.example), not an IP address or a single word.",
    );
  }
  return { url: `https://${host}`, host };
}
