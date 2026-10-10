import { sign, verify } from "../auth/signed-value";

/**
 * What a bot holds in place of a person's model key.
 *
 * The bot never sees the key, and never needs to. It is handed this instead, which the model
 * gateway accepts as if it were an API key, looks up the person's connection with, and swaps for the
 * real key when it forwards the request. So a bot that is compromised, or simply careless, has
 * nothing to leak but a token that names one connection, works only against this deployment's
 * gateway, and stops working after twenty minutes.
 */
export type ModelGrant = {
  actorId: string;
  connectionId: string;
};

/** Signed under its own label, so it can never be replayed as a run assertion or a cookie. */
const LABEL = "ark:model-grant";

/**
 * A long run is a tool loop of many model calls, so this has to outlast a slow one, and a captured
 * grant stops being worth anything soon after. The connection is re-read on every call, so deleting
 * a connection or changing its key takes effect at once regardless of this.
 */
export const GRANT_TTL_MS = 20 * 60 * 1000;

type Signed = ModelGrant & { exp: number };

export function mintModelGrant(
  grant: ModelGrant,
  encryptionKey: string,
  now: number = Date.now(),
): string {
  const payload: Signed = { ...grant, exp: now + GRANT_TTL_MS };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return sign(value, encryptionKey, LABEL);
}

/** The grant a token carries, or null on any doubt: bad signature, expired, wrong shape. */
export function readModelGrant(
  token: unknown,
  encryptionKey: string,
  now: number = Date.now(),
): ModelGrant | null {
  if (typeof token !== "string" || !token) return null;
  const value = verify(token, encryptionKey, LABEL);
  if (!value) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<Signed>;
    if (
      typeof payload.actorId !== "string" ||
      !payload.actorId ||
      typeof payload.connectionId !== "string" ||
      !payload.connectionId ||
      typeof payload.exp !== "number" ||
      payload.exp <= now
    ) {
      return null;
    }
    return { actorId: payload.actorId, connectionId: payload.connectionId };
  } catch {
    return null;
  }
}
