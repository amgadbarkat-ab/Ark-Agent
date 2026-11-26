/**
 * The join code a staff computer is given (Amgad, 24 Nov 2026, option A): where the company's
 * ArkAgent answers on the office network, and the fingerprint of the one certificate to trust there.
 *
 * With remote staff switched on (v0.1.56) it also says how to reach the company's ArkAgent through
 * BlackArk's staff relay: the relay's address, this office's id there, and the access key the relay
 * asks of a staff computer. That key opens only the relay's way through, to the same TLS listener
 * the office network uses, whose certificate the staff computer still checks by the fingerprint.
 * It lets nobody into ArkAgent: each person still signs in with their own email and password. A
 * new join code makes the relay forget the old access key.
 */
export type RelayPart = {
  /** The relay's address, `wss://…`. */
  url: string;
  office: string;
  key: string;
};

export type JoinCode = {
  /** The administrator's computer's addresses on the office network, most likely first. */
  addresses: string[];
  port: number;
  /** SHA-256 of the certificate, lower-case hex. */
  fingerprint: string;
  relay?: RelayPart;
};

const PREFIX = "ARK-";
const ID = /^[A-Za-z0-9_-]{22,128}$/;

export function encodeJoinCode(code: JoinCode): string {
  const body = JSON.stringify({
    v: 1,
    a: code.addresses,
    p: code.port,
    f: code.fingerprint,
    ...(code.relay
      ? { r: { u: code.relay.url, o: code.relay.office, k: code.relay.key } }
      : {}),
  });
  return PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

function relayPart(raw: unknown): RelayPart | null {
  if (!raw || typeof raw !== "object") return null;
  const { u, o, k } = raw as { u?: unknown; o?: unknown; k?: unknown };
  if (typeof u !== "string" || typeof o !== "string" || typeof k !== "string")
    return null;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  // Only BlackArk's relay over TLS; plain ws:// only to this computer, which the tests use.
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local))
    return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!ID.test(o) || !ID.test(k)) return null;
  return { url: u.replace(/\/+$/, ""), office: o, key: k };
}

/** The code read back, or null when it is not one (a typo, a cut-off paste, somebody else's text). */
export function parseJoinCode(text: string): JoinCode | null {
  const trimmed = text.trim().replace(/\s+/g, "");
  if (!trimmed.startsWith(PREFIX) || trimmed.length > 4096) return null;
  try {
    const raw = JSON.parse(
      Buffer.from(trimmed.slice(PREFIX.length), "base64url").toString("utf8"),
    ) as { v?: unknown; a?: unknown; p?: unknown; f?: unknown; r?: unknown };
    if (raw.v !== 1) return null;
    const addresses = Array.isArray(raw.a)
      ? raw.a.filter(
          (one): one is string =>
            typeof one === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(one),
        )
      : [];
    const port = Number(raw.p);
    const fingerprint = typeof raw.f === "string" ? raw.f.toLowerCase() : "";
    const relay = raw.r === undefined ? null : relayPart(raw.r);
    if (raw.r !== undefined && !relay) return null;
    if (
      (addresses.length === 0 && !relay) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[0-9a-f]{64}$/.test(fingerprint)
    )
      return null;
    return {
      addresses: addresses.slice(0, 8),
      port,
      fingerprint,
      ...(relay ? { relay } : {}),
    };
  } catch {
    return null;
  }
}
