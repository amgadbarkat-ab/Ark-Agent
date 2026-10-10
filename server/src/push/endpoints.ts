/**
 * Which addresses this server will send a notification to.
 *
 * A subscription's endpoint is chosen by whoever sends it, and the server then makes a request to it.
 * Taken as given, that is a way to make this server call any address it can reach (its database, the
 * cloud's metadata service, a neighbour's admin port). So an endpoint must be an https address on one
 * of the services browsers actually use, and nothing else. Anything on the list is a public service
 * run by Google, Mozilla, Apple or Microsoft; an operator who needs another adds it in
 * `WEB_PUSH_ALLOWED_HOSTS`.
 */

/** A name that matches itself or anything under it: `push.apple.com` is `web.push.apple.com` too. */
const DOMAINS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export function isAllowedPushEndpoint(
  address: string,
  extraHosts: readonly string[] = [],
): boolean {
  if (address.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  // A port other than 443 is how a request is steered at a service that is not a push service.
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // An address, not a name: never a push service, and the first thing an attack would try.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
  return [...DOMAINS, ...extraHosts.map((value) => value.toLowerCase())].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}
