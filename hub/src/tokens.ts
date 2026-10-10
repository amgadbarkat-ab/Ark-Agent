import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What a browser is allowed to join.
 *
 * A token names exactly one thing, so a leaked token for one conversation reads that conversation
 * and nothing else.
 */
export type JoinScope =
  | { kind: "thread"; threadId: string; userId: string }
  | { kind: "meta"; userId: string };

interface Claims {
  s: JoinScope;
  exp: number;
}

const encode = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

function mac(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest();
}

export function signJoinToken(
  secret: string,
  scope: JoinScope,
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const claims: Claims = { s: scope, exp: Math.floor(now / 1000) + ttlSeconds };
  const body = encode(JSON.stringify(claims));
  return `${body}.${encode(mac(secret, body))}`;
}

/** The scope a token grants, or null for anything forged, malformed or expired. */
export function verifyJoinToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): JoinScope | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = mac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims?.exp !== "number" || claims.exp * 1000 <= now) return null;
  const scope = claims.s;
  if (scope?.kind === "thread" && scope.threadId && scope.userId) return scope;
  if (scope?.kind === "meta" && scope.userId) return scope;
  return null;
}

/**
 * The stable, non-secret name of a person's thread-list channel.
 *
 * Derived rather than stored so any hub instance computes the same code. It is only a topic name:
 * joining it still requires a token scoped to that person.
 */
export function joinCodeFor(secret: string, userId: string): string {
  return mac(secret, `meta:${userId}`).toString("hex").slice(0, 16);
}
