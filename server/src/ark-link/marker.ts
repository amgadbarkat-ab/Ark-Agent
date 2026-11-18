/**
 * Whether a request reached this server through Ark Link (#149), from which paired phone.
 *
 * The connector makes each phone request again on 127.0.0.1, and marks it with a secret this process
 * draws once at start and keeps in memory, and with the id of the device it checked. Nothing a phone
 * or a page sends can carry the mark: the connector drops every `x-ark-link-*` header the phone sent,
 * and every header that names a person, before it adds its own, and the secret exists nowhere outside
 * this process. So the server tells a phone's request from the computer's own, and which phone it is,
 * from the request itself rather than from anything the client says about itself.
 *
 * Used to act as the person the phone is bound to (`sessions.ts`), to refuse what a phone cannot
 * finish (an OAuth sign-in that returns to the computer), and to say in the audit trail that a call
 * came through Ark Link.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

const PROOF = "x-ark-link-proof";
const DEVICE = "x-ark-link-device";
const PREFIX = "x-ark-link";
const secret = crypto.randomUUID() + crypto.randomUUID();
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Headers a phone could use to say who it is, which nothing here may believe from a phone. The server
 * reads none of them today; they are taken off so that nothing added later can be talked into it.
 */
const NAMES_A_PERSON =
  /(^|-)(user|users|actor|impersonate|impersonation|principal|identity|email)(-|$)/i;

/** Takes off anything the phone sent that looks like the mark or names a person, then marks the request. */
export function markLinkRequest(headers: Headers, deviceId: string): Headers {
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower === "user-agent") continue;
    if (lower.startsWith(PREFIX) || NAMES_A_PERSON.test(lower))
      headers.delete(name);
  }
  headers.set(PROOF, secret);
  headers.set(DEVICE, deviceId);
  return headers;
}

function proven(headers: Headers): boolean {
  const value = headers.get(PROOF);
  if (!value || value.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < value.length; i++)
    diff |= value.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

/** The paired device a request came from, only for a request the connector made; otherwise null. */
export function linkDeviceOf(headers: Headers): string | null {
  if (!proven(headers)) return null;
  const device = headers.get(DEVICE) ?? "";
  return DEVICE_ID.test(device) ? device : null;
}

/** True only for a request the connector made for a phone. */
export function cameThroughArkLink(headers: Headers): boolean {
  return linkDeviceOf(headers) !== null;
}

/** The phone a request in progress came from, for the audit trail. */
const current = new AsyncLocalStorage<{ deviceId: string }>();

export function currentLinkDevice(): string | null {
  return current.getStore()?.deviceId ?? null;
}

/** Runs `work` as part of a request from `deviceId`. For the WebSocket paths outside Hono, and tests. */
export function asLinkRequest<T>(deviceId: string, work: () => T): T {
  return current.run({ deviceId }, work);
}

/** Middleware: everything a phone's request leads to, audit rows included, knows which phone. */
export const arkLinkRequestContext: MiddlewareHandler = async (
  context,
  next,
) => {
  const deviceId = linkDeviceOf(context.req.raw.headers);
  if (!deviceId) return next();
  await current.run({ deviceId }, next);
};

/** What a phone is told where a connector would start a sign-in that returns to the computer. */
export const CONNECT_ON_COMPUTER =
  "Connect this on your computer: the sign-in returns to the computer, so it cannot finish on a phone.";

/** What a phone is told for any sign-in page or sign-in call: the phone acts as its person already. */
export const SIGN_IN_ON_COMPUTER =
  "Sign in on your computer. This phone acts as the person it was paired for, and never signs in itself.";
