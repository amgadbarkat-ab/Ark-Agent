import { isIP } from "node:net";

/**
 * Which `Host` a request on this computer may name (security review of v0.1.54, 25 Nov 2026).
 *
 * DNS rebinding: a web page on somebody's own domain is made to resolve to 127.0.0.1, so the browser
 * sends it to this computer's server as "the same site" (its Origin and its Host both name that
 * domain, which is how it got past the cross-site check). It always has to name a domain. So a
 * domain is refused unless it is one this computer's own parts use: `localhost`, and the names the
 * desktop's containers reach this computer by. An address (127.0.0.1, 192.168.1.20, [::1]) is not a
 * name anybody can rebind, and stays allowed.
 */
const OWN_NAMES = new Set([
  "localhost",
  "host.docker.internal",
  "host.containers.internal",
]);

/** The name in a `Host` header, without its port or brackets, lower-case; null when there is none. */
export function hostName(header: string | null): string | null {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : null;
  }
  const colon = value.lastIndexOf(":");
  // A bare IPv6 address has several colons and no port.
  if (colon > 0 && value.indexOf(":") === colon) return value.slice(0, colon);
  return value;
}

export function hostAllowed(
  header: string | null,
  extraNames: readonly string[] = [],
): boolean {
  const name = hostName(header);
  // No Host at all is not a browser: browsers always send one.
  if (name === null) return true;
  if (isIP(name) !== 0) return true;
  if (OWN_NAMES.has(name) || name.endsWith(".localhost")) return true;
  return extraNames.some((extra) => extra.toLowerCase() === name);
}
