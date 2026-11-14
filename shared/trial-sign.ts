/**
 * Ed25519 signing and checking for trial profiles and unlock codes. Server and signing tool only:
 * it needs `node:crypto`, which the browser app does not have.
 *
 * A public key is written as base64 of its 32 raw bytes: short enough to paste into an issue or a
 * repository variable. The private key never leaves the signing computer; see scripts/ark-trial.ts.
 */
import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";

/** The fixed DER header of an Ed25519 public key, before its 32 bytes. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function publicKeyFromBase64(encoded: string): KeyObject {
  const raw = Buffer.from(encoded.trim(), "base64");
  if (raw.length !== 32) {
    throw new Error("A trial public key is 32 bytes, written in base64.");
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function publicKeyToBase64(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(SPKI_PREFIX.length)).toString("base64");
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** The signature over exactly these characters. */
export function signText(privateKey: KeyObject, text: string): string {
  return base64url(sign(null, Buffer.from(text, "utf8"), privateKey));
}

/** Whether any of these keys signed exactly these characters. */
export function signedByAny(
  keys: readonly KeyObject[],
  text: string,
  signature: string,
): boolean {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  return keys.some((key) => {
    try {
      return verify(null, Buffer.from(text, "utf8"), key, bytes);
    } catch {
      return false;
    }
  });
}
