/**
 * Signing in inside the iOS app, which has to happen outside it.
 *
 * Google refuses to sign anybody in inside an embedded web view, and the iOS app is one. So signing
 * in opens the system browser at a page of this server (`/api/auth/native`), the browser signs in
 * with whichever provider was chosen, and then opens the app again by its own address with a code in
 * it. This file is the app's half: it makes the secret, builds the address to open, and decides
 * whether an address the app was opened with is the answer to a sign-in it started.
 *
 * THE SECRET NEVER LEAVES THE PHONE. The address that brings the app back can be read by any other
 * app that claims the same scheme, so the code in it is worth nothing alone. It is bound to a
 * challenge made from a secret (`verifier`) that is only ever kept here and sent to this server
 * over the app's own connection. The server checks the pair, once.
 *
 * Pure apart from the two things injected, so each rule can be tested without a phone.
 */

/** Where the browser sends a person back to. Must match `APP_RETURN_HOST` on the server. */
export const RETURN_HOST = "signed-in";

/** How long a started sign-in may take before its secret is forgotten. Providers' own pages are slower than this only when somebody has walked away. */
export const MOST_MS = 10 * 60 * 1000;

/** The providers the system-browser page can start. Company sign-in is not offered in the app yet. */
export type NativeProvider = "google" | "microsoft";
export const NATIVE_PROVIDERS: readonly NativeProvider[] = [
  "google",
  "microsoft",
];

export type Pending = { state: string; verifier: string; startedAt: number };

/** Where the secret waits while the browser is open. Survives the web view being unloaded meanwhile. */
export type PendingStore = {
  read: () => Pending | null;
  write: (pending: Pending) => void;
  clear: () => void;
};

const STORAGE_KEY = "ark.native-sign-in";

export const browserPendingStore: PendingStore = {
  read() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<Pending>;
      if (
        typeof value.state === "string" &&
        typeof value.verifier === "string" &&
        typeof value.startedAt === "number"
      ) {
        return value as Pending;
      }
    } catch {
      // Nothing usable is the same as nothing.
    }
    return null;
  },
  write(pending) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    } catch {
      // Without it the return cannot be matched, which fails closed: the person tries again.
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to remove.
    }
  },
};

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** Random text of the URL-safe alphabet, from the system's source of randomness. */
export function randomToken(byteLength: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** What the server is given in place of the secret: its SHA-256, in 43 URL-safe characters. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Start a sign-in: make the secret, keep it, and open the system browser at the server's page.
 *
 * `open` is what shows the page (the platform's in-app browser). It is injected because the platform
 * is not here to test with.
 */
export async function beginNativeSignIn(input: {
  provider: NativeProvider;
  scheme: string;
  origin: string;
  open: (address: string) => Promise<void>;
  store?: PendingStore;
  now?: () => number;
}): Promise<void> {
  const store = input.store ?? browserPendingStore;
  const now = input.now ?? Date.now;
  const state = randomToken(24);
  const verifier = randomToken(32);
  store.write({ state, verifier, startedAt: now() });
  const address = new URL("/api/auth/native", input.origin);
  address.searchParams.set("provider", input.provider);
  address.searchParams.set("state", state);
  address.searchParams.set("code_challenge", await challengeFor(verifier));
  address.searchParams.set("redirect_uri", `${input.scheme}://${RETURN_HOST}`);
  await input.open(address.href);
}

/** What to send the server to turn the code into a session. */
export type Grant = { code: string; state: string; verifier: string };

/**
 * Whether an address the app was opened with is the answer to the sign-in it started, and if so what
 * to send the server.
 *
 * Anything else returns null and changes nothing: another app opening this one with a made-up
 * address, an old answer, an answer to a sign-in somebody else started on this phone. In particular
 * a `state` that is not the one kept here is refused, which is what stops an address crafted to make
 * the app sign in as somebody the attacker chose.
 */
export function grantFrom(
  address: string,
  scheme: string,
  pending: Pending | null,
  now: number,
): Grant | null {
  if (!pending || now - pending.startedAt > MOST_MS) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${scheme}:` ||
    url.hostname !== RETURN_HOST ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return null;
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9]{16,128}$/.test(code) || state !== pending.state) {
    return null;
  }
  return { code, state, verifier: pending.verifier };
}
