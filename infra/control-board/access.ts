/**
 * Cloudflare Access in front of the board (`FIRST_FACTOR=access`): Access lets through only people
 * its policy allows, and adds `Cf-Access-Jwt-Assertion`, a JWT signed with the team's keys. The
 * board checks it on every request (WebCrypto, no package) and takes the email in it as the first
 * factor: it must belong to a board account. The board's TOTP is still asked for after it.
 *
 * The check:
 * - RS256, with the key named by `kid` from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
 *   (kept an hour; fetched again, at most once a minute, when a new `kid` appears);
 * - `aud` contains the application's AUD tag, `iss` is the team domain;
 * - not expired, and not from the future (a minute's leeway each way).
 */
import { Buffer } from "node:buffer";

export type AccessSettings = {
  /** e.g. "blackark.cloudflareaccess.com". */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export type AccessResult =
  | { ok: true; email: string | null }
  | { ok: false; reason: string };

export type AccessCheck = (request: Request) => Promise<AccessResult>;

type Jwk = { kid?: string; kty?: string; n?: string; e?: string };

const LEEWAY_SECONDS = 60;
const KEYS_TTL_MS = 60 * 60_000;
const REFETCH_MIN_MS = 60_000;

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function cloudflareAccess(settings: AccessSettings): AccessCheck {
  const send = settings.fetch ?? fetch;
  const now = settings.now ?? Date.now;
  const issuer = `https://${settings.teamDomain}`;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;

  async function loadKeys(): Promise<void> {
    const response = await send(`${issuer}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Access keys answered ${response.status}.`);
    const body = (await response.json()) as { keys?: Jwk[] };
    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
      next.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid: string): Promise<CryptoKey | undefined> {
    if (now() - fetchedAt > KEYS_TTL_MS) await loadKeys();
    if (!keys.has(kid) && now() - fetchedAt > REFETCH_MIN_MS) await loadKeys();
    return keys.get(kid);
  }

  return async (request) => {
    const token = request.headers.get("cf-access-jwt-assertion") ?? "";
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    ) {
      return { ok: false, reason: "no assertion" };
    }
    const [head = "", body = "", signature = ""] = parts;
    let header: { alg?: string; kid?: string };
    let claims: {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      nbf?: number;
      iat?: number;
      email?: string;
    };
    try {
      header = decodePart(head) as typeof header;
      claims = decodePart(body) as typeof claims;
    } catch {
      return { ok: false, reason: "unreadable assertion" };
    }
    if (header.alg !== "RS256" || !header.kid)
      return { ok: false, reason: "not RS256" };
    let key: CryptoKey | undefined;
    try {
      key = await keyFor(header.kid);
    } catch {
      return { ok: false, reason: "keys unavailable" };
    }
    if (!key) return { ok: false, reason: "unknown key" };
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      new Uint8Array(Buffer.from(signature, "base64url")),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!valid) return { ok: false, reason: "bad signature" };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(settings.aud))
      return { ok: false, reason: "wrong audience" };
    if (claims.iss !== issuer) return { ok: false, reason: "wrong issuer" };
    const seconds = now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < seconds)
      return { ok: false, reason: "expired" };
    if ((claims.nbf ?? claims.iat ?? 0) - LEEWAY_SECONDS > seconds)
      return { ok: false, reason: "not yet valid" };
    return {
      ok: true,
      email:
        typeof claims.email === "string" ? claims.email.toLowerCase() : null,
    };
  };
}
