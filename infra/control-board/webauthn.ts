/**
 * Passkeys (WebAuthn), written here with WebCrypto and no package: the board's first factor when it
 * is not behind Cloudflare Access (`FIRST_FACTOR=passkey`). The board's TOTP is still asked for
 * after it, every time.
 *
 * What is checked, at registration and at each sign-in:
 * - the browser's clientData: its type, OUR challenge (single use, 5 minutes) and OUR origin;
 * - the authenticator data: the SHA-256 of our relying-party id (the board's host name), and the
 *   user-present flag;
 * - at sign-in, the signature over authenticatorData || SHA-256(clientDataJSON), with the public
 *   key kept at registration (ES256 or RS256), and a signature counter that must move forward when
 *   the authenticator keeps one (a cloned key shows as a counter going back).
 * Attestation is not asked for ("none"): the board trusts the person who held the setup link, not
 * a hardware vendor.
 */

import { Buffer } from "node:buffer";

export type PublicKeyJwk = JsonWebKey & { kty: "EC" | "RSA" };

export type StoredPasskey = {
  credentialId: string;
  publicKey: PublicKeyJwk;
  algorithm: -7 | -257;
  signCount: number;
};

export type Expected = { challenge: string; origin: string; rpId: string };

export class PasskeyError extends Error {}

const ES256 = -7;
const RS256 = -257;

// ---- base64url ---------------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new PasskeyError("not base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function randomChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
  const data =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>),
  );
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// ---- CBOR, the subset WebAuthn uses ------------------------------------------------------------

type Cbor =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | Cbor[]
  | Map<Cbor, Cbor>;

/** Decodes one CBOR item; returns it and where it ended. */
export function decodeCbor(
  bytes: Uint8Array,
  start = 0,
): { value: Cbor; end: number } {
  let at = start;
  const byte = () => {
    if (at >= bytes.length) throw new PasskeyError("CBOR ends early");
    return bytes[at++] as number;
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return byte();
    if (info === 25) return (byte() << 8) | byte();
    if (info === 26)
      return ((byte() << 24) >>> 0) + (byte() << 16) + (byte() << 8) + byte();
    throw new PasskeyError("CBOR length not supported");
  };
  const item = (): Cbor => {
    const head = byte();
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        if (at + n > bytes.length) throw new PasskeyError("CBOR ends early");
        const out = bytes.slice(at, at + n);
        at += n;
        return out;
      }
      case 3: {
        const n = length(info);
        if (at + n > bytes.length) throw new PasskeyError("CBOR ends early");
        const out = new TextDecoder().decode(bytes.slice(at, at + n));
        at += n;
        return out;
      }
      case 4: {
        const n = length(info);
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(item());
        return out;
      }
      case 5: {
        const n = length(info);
        const out = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const key = item();
          out.set(key, item());
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new PasskeyError("CBOR value not supported");
      default:
        throw new PasskeyError("CBOR type not supported");
    }
  };
  const value = item();
  return { value, end: at };
}

// ---- Authenticator data ------------------------------------------------------------------------

type AuthData = {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: Map<Cbor, Cbor>;
};

function readAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new PasskeyError("authenticator data too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data[32] as number;
  const out: AuthData = {
    rpIdHash: data.slice(0, 32),
    flags,
    signCount: view.getUint32(33),
  };
  if (flags & 0x40) {
    // Attested credential data: AAGUID (16), id length (2), id, COSE key.
    if (data.length < 55) throw new PasskeyError("credential data too short");
    const idLength = view.getUint16(53);
    out.credentialId = data.slice(55, 55 + idLength);
    const key = decodeCbor(data, 55 + idLength).value;
    if (!(key instanceof Map)) throw new PasskeyError("no public key");
    out.publicKey = key;
  }
  return out;
}

function coseToJwk(key: Map<Cbor, Cbor>): {
  jwk: PublicKeyJwk;
  algorithm: -7 | -257;
} {
  const alg = key.get(3);
  if (key.get(1) === 2 && alg === ES256 && key.get(-1) === 1) {
    const x = key.get(-2);
    const y = key.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array))
      throw new PasskeyError("bad EC key");
    return {
      jwk: { kty: "EC", crv: "P-256", x: toBase64Url(x), y: toBase64Url(y) },
      algorithm: ES256,
    };
  }
  if (key.get(1) === 3 && alg === RS256) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array))
      throw new PasskeyError("bad RSA key");
    return {
      jwk: { kty: "RSA", n: toBase64Url(n), e: toBase64Url(e) },
      algorithm: RS256,
    };
  }
  throw new PasskeyError("only ES256 and RS256 passkeys are accepted");
}

async function checkClientData(
  clientDataJSON: Uint8Array,
  type: string,
  expected: Expected,
) {
  let data: {
    type?: string;
    challenge?: string;
    origin?: string;
    crossOrigin?: boolean;
  };
  try {
    data = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    throw new PasskeyError("unreadable client data");
  }
  if (data.type !== type) throw new PasskeyError("wrong ceremony");
  if (data.challenge !== expected.challenge)
    throw new PasskeyError("wrong challenge");
  if (data.origin !== expected.origin) throw new PasskeyError("wrong origin");
  if (data.crossOrigin === true) throw new PasskeyError("cross-origin");
}

async function checkAuthData(auth: AuthData, expected: Expected) {
  if (!equalBytes(auth.rpIdHash, await sha256(expected.rpId)))
    throw new PasskeyError("wrong relying party");
  if (!(auth.flags & 0x01)) throw new PasskeyError("user not present");
}

// ---- The two ceremonies ------------------------------------------------------------------------

/** What `navigator.credentials.create` is given (binary fields as base64url; webauthn.js decodes). */
export function registrationOptions(input: {
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  challenge: string;
  exclude: string[];
}) {
  return {
    challenge: input.challenge,
    rp: { id: input.rpId, name: input.rpName },
    user: {
      id: toBase64Url(new TextEncoder().encode(input.userId)),
      name: input.userName,
      displayName: input.userName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: ES256 },
      { type: "public-key", alg: RS256 },
    ],
    timeout: 300_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
    excludeCredentials: input.exclude.map((id) => ({ type: "public-key", id })),
  };
}

/** What `navigator.credentials.get` is given: any of this site's passkeys (discoverable). */
export function signInOptions(input: { rpId: string; challenge: string }) {
  return {
    challenge: input.challenge,
    rpId: input.rpId,
    timeout: 300_000,
    userVerification: "preferred",
  };
}

export async function verifyRegistration(
  response: { clientDataJSON: string; attestationObject: string },
  expected: Expected,
): Promise<StoredPasskey> {
  await checkClientData(
    fromBase64Url(response.clientDataJSON),
    "webauthn.create",
    expected,
  );
  const attestation = decodeCbor(
    fromBase64Url(response.attestationObject),
  ).value;
  if (!(attestation instanceof Map))
    throw new PasskeyError("unreadable attestation");
  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array))
    throw new PasskeyError("no authenticator data");
  const auth = readAuthData(authData);
  await checkAuthData(auth, expected);
  if (!auth.credentialId || !auth.publicKey)
    throw new PasskeyError("no credential");
  const { jwk, algorithm } = coseToJwk(auth.publicKey);
  return {
    credentialId: toBase64Url(auth.credentialId),
    publicKey: jwk,
    algorithm,
    signCount: auth.signCount,
  };
}

/** ECDSA signatures arrive DER-encoded; WebCrypto wants r and s, 32 bytes each. */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new PasskeyError("bad signature");
  let at = 2;
  const part = () => {
    if (der[at] !== 0x02) throw new PasskeyError("bad signature");
    const length = der[at + 1] as number;
    let value = der.slice(at + 2, at + 2 + length);
    at += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new PasskeyError("bad signature");
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/** Checks a sign-in; returns the new signature counter. */
export async function verifySignIn(
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  },
  stored: StoredPasskey,
  expected: Expected,
): Promise<number> {
  const clientData = fromBase64Url(response.clientDataJSON);
  await checkClientData(clientData, "webauthn.get", expected);
  const authBytes = fromBase64Url(response.authenticatorData);
  const auth = readAuthData(authBytes);
  await checkAuthData(auth, expected);
  const signed = new Uint8Array(authBytes.length + 32);
  signed.set(authBytes, 0);
  signed.set(await sha256(clientData), authBytes.length);
  const signature = fromBase64Url(response.signature);
  const ok =
    stored.algorithm === ES256
      ? await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          await crypto.subtle.importKey(
            "jwk",
            stored.publicKey,
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          ),
          derToRaw(signature) as Uint8Array<ArrayBuffer>,
          signed,
        )
      : await crypto.subtle.verify(
          { name: "RSASSA-PKCS1-v1_5" },
          await crypto.subtle.importKey(
            "jwk",
            stored.publicKey,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
          signature as Uint8Array<ArrayBuffer>,
          signed,
        );
  if (!ok) throw new PasskeyError("bad signature");
  if (
    (auth.signCount !== 0 || stored.signCount !== 0) &&
    auth.signCount <= stored.signCount
  ) {
    throw new PasskeyError("signature counter went back");
  }
  return auth.signCount;
}

/** The browser half (served as /webauthn.js; the CSP allows scripts from the board only). */
export const BROWSER_SCRIPT = `"use strict";
(() => {
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const bin = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const form = document.querySelector("form[data-passkey]");
  if (!form || !window.PublicKeyCredential) return;
  const status = form.querySelector("[data-passkey-status]");
  form.addEventListener("submit", async (event) => {
    if (form.dataset.ready === "1") return;
    event.preventDefault();
    try {
      const answer = await fetch(form.dataset.passkey, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: form.elements.csrf.value }),
        credentials: "same-origin",
      });
      if (!answer.ok) throw new Error(String(answer.status));
      const options = await answer.json();
      form.elements.challengeId.value = options.challengeId;
      const publicKey = options.publicKey;
      publicKey.challenge = bin(publicKey.challenge);
      let credential;
      if (form.dataset.ceremony === "register") {
        publicKey.user.id = bin(publicKey.user.id);
        publicKey.excludeCredentials = (publicKey.excludeCredentials || []).map((c) => ({ ...c, id: bin(c.id) }));
        credential = await navigator.credentials.create({ publicKey });
        form.elements.attestationObject.value = b64(credential.response.attestationObject);
      } else {
        credential = await navigator.credentials.get({ publicKey });
        form.elements.authenticatorData.value = b64(credential.response.authenticatorData);
        form.elements.signature.value = b64(credential.response.signature);
      }
      form.elements.credentialId.value = b64(credential.rawId);
      form.elements.clientDataJSON.value = b64(credential.response.clientDataJSON);
      form.dataset.ready = "1";
      form.submit();
    } catch (error) {
      if (status) status.hidden = false;
    }
  });
})();
`;
