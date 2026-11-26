/**
 * The set-up secret the desktop gives its own window (security review of v0.1.54, 25 Nov 2026).
 *
 * The desktop opens the app with `#ark-setup=<secret>`. Read before the router moves anywhere (a
 * redirect to the sign-in screen drops the fragment), kept for this window's session only, and taken
 * out of the address at once, so it is in no history entry and no link anybody copies. The server
 * makes the administrator only for a request that carries it: nothing else on the computer, and no
 * web page, knows it.
 */
const KEY = "ark-setup";
export const SETUP_TOKEN_HEADER = "x-ark-setup-token";

export function captureSetupSecret(
  location: {
    hash: string;
    pathname: string;
    search: string;
  } = window.location,
  history: Pick<History, "replaceState"> = window.history,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.sessionStorage,
) {
  if (!location.hash.includes(`${KEY}=`)) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const secret = params.get(KEY);
  params.delete(KEY);
  try {
    if (secret) storage?.setItem(KEY, secret);
  } catch {
    // No storage: set-up simply asks for the window again.
  }
  const rest = params.toString();
  history.replaceState(
    (history as Partial<History>).state ?? null,
    "",
    `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`,
  );
}

/** The header for the set-up request, or none where this window was not given the secret. */
export function setupSecretHeaders(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.sessionStorage,
): Record<string, string> {
  try {
    const secret = storage?.getItem(KEY);
    return secret ? { [SETUP_TOKEN_HEADER]: secret } : {};
  } catch {
    return {};
  }
}
