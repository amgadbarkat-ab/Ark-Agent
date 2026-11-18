/**
 * Whether a request reached this server through Ark Link (#149), from a phone.
 *
 * The connector makes each phone request again on 127.0.0.1, and marks it with a secret this process
 * draws once at start and keeps in memory. Nothing a phone or a page sends can carry it: the connector
 * drops every `x-ark-link-*` header the phone sent before it adds its own, and the value exists
 * nowhere outside this process. So the server can tell a phone's request from the computer's own,
 * from the request itself rather than from anything the client says about itself.
 *
 * Used where a phone cannot finish what the computer can, such as an OAuth sign-in whose return
 * address is this computer (Amgad, 18 Nov: "Connect this on your computer").
 */

const HEADER = "x-ark-link-proof";
const PREFIX = "x-ark-link";
const secret = crypto.randomUUID() + crypto.randomUUID();

/** Takes off anything the phone sent that looks like the mark, then marks the request. */
export function markLinkRequest(headers: Headers): Headers {
  for (const name of [...headers.keys()])
    if (name.toLowerCase().startsWith(PREFIX)) headers.delete(name);
  headers.set(HEADER, secret);
  return headers;
}

/** True only for a request the connector made for a phone. */
export function cameThroughArkLink(headers: Headers): boolean {
  const value = headers.get(HEADER);
  if (!value || value.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < value.length; i++)
    diff |= value.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** What a phone is told where a connector would start a sign-in that returns to the computer. */
export const CONNECT_ON_COMPUTER =
  "Connect this on your computer: the sign-in returns to the computer, so it cannot finish on a phone.";
