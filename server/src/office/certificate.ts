import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";

/**
 * The office network's own certificate (Amgad, 24 Nov 2026, option A).
 *
 * Nobody outside the office can vouch for an address like 192.168.1.20, so this ArkAgent makes a
 * certificate for itself and the staff computers trust that one certificate, and no other, by its
 * SHA-256 fingerprint in the join code. Written out here in DER rather than with a library: an
 * ECDSA P-256 key, a ten-year self-signed X.509 v3 certificate, the computer's addresses as its
 * alternative names. No new dependency, and `node:crypto` reads it back in the tests.
 */
export type OfficeCertificate = {
  certificate: string;
  key: string;
  fingerprint: string;
};

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function objectId(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const out = [first * 40 + second];
  for (const value of rest) {
    const groups = [value & 0x7f];
    for (let high = value >> 7; high > 0; high >>= 7)
      groups.unshift((high & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(raw: Buffer): Buffer {
  let bytes = raw;
  while (bytes.length > 1 && bytes[0] === 0 && !((bytes[1] ?? 0) & 0x80))
    bytes = bytes.subarray(1);
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function utcTime(at: Date): Buffer {
  const two = (n: number) => String(n).padStart(2, "0");
  const text = `${two(at.getUTCFullYear() % 100)}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DAY = 86_400_000;

/** A new certificate and key for this ArkAgent, naming the addresses staff reach it at. */
export function makeOfficeCertificate(
  names: { addresses: string[]; hostnames: string[] },
  now = new Date(),
): OfficeCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const ecdsaSha256 = sequence(objectId("1.2.840.10045.4.3.2"));
  const name = sequence(
    set(
      sequence(
        objectId("2.5.4.3"),
        tlv(0x0c, Buffer.from("ArkAgent office server", "utf8")),
      ),
    ),
  );
  const alternatives = [
    ...names.hostnames
      .filter((host) => /^[A-Za-z0-9.-]{1,253}$/.test(host))
      .map((host) => tlv(0x82, Buffer.from(host, "ascii"))),
    ...names.addresses.flatMap((address) => {
      const parts = IPV4.exec(address)?.slice(1).map(Number);
      return parts?.every((part) => part <= 255)
        ? [tlv(0x87, Buffer.from(parts))]
        : [];
    }),
  ];
  const extensions = alternatives.length
    ? [
        tlv(
          0xa3,
          sequence(
            sequence(
              objectId("2.5.29.17"),
              tlv(0x04, sequence(...alternatives)),
            ),
          ),
        ),
      ]
    : [];
  const toBeSigned = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    ecdsaSha256,
    name,
    sequence(
      utcTime(new Date(now.getTime() - DAY)),
      utcTime(new Date(now.getTime() + 3650 * DAY)),
    ),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    ...extensions,
  );
  const signature = sign("sha256", toBeSigned, {
    key: privateKey,
    dsaEncoding: "der",
  });
  const der = sequence(
    toBeSigned,
    ecdsaSha256,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint: createHash("sha256").update(der).digest("hex"),
  };
}

/** The SHA-256 fingerprint of a PEM certificate, lower-case hex, as the join code carries it. */
export function fingerprintOf(pem: string): string {
  return new X509Certificate(pem).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
}
