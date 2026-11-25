/**
 * The join code a staff computer is given (Amgad, 24 Nov 2026, option A): where the company's
 * ArkAgent answers on the office network, and the fingerprint of the one certificate to trust there.
 * Not a secret: it lets nobody in. Each person still signs in with their own email and password.
 */
export type JoinCode = {
  /** The administrator's computer's addresses on the office network, most likely first. */
  addresses: string[];
  port: number;
  /** SHA-256 of the certificate, lower-case hex. */
  fingerprint: string;
};

const PREFIX = "ARK-";

export function encodeJoinCode(code: JoinCode): string {
  const body = JSON.stringify({
    v: 1,
    a: code.addresses,
    p: code.port,
    f: code.fingerprint,
  });
  return PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

/** The code read back, or null when it is not one (a typo, a cut-off paste, somebody else's text). */
export function parseJoinCode(text: string): JoinCode | null {
  const trimmed = text.trim().replace(/\s+/g, "");
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const raw = JSON.parse(
      Buffer.from(trimmed.slice(PREFIX.length), "base64url").toString("utf8"),
    ) as { v?: unknown; a?: unknown; p?: unknown; f?: unknown };
    if (raw.v !== 1) return null;
    const addresses = Array.isArray(raw.a)
      ? raw.a.filter(
          (one): one is string =>
            typeof one === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(one),
        )
      : [];
    const port = Number(raw.p);
    const fingerprint = typeof raw.f === "string" ? raw.f.toLowerCase() : "";
    if (
      addresses.length === 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[0-9a-f]{64}$/.test(fingerprint)
    )
      return null;
    return { addresses: addresses.slice(0, 8), port, fingerprint };
  } catch {
    return null;
  }
}
