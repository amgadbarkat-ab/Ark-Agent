import { tNow } from "@/lib/i18n";
/**
 * Finishing a sign-in from the address the browser ended on, for when the browser cannot reach this
 * app (DT Lab, #83: the browser ran on another network, so `http://localhost:…/api/plugins/oauth/
 * callback` never loaded, and the consent was finished by hand from a shell).
 *
 * Only the two values the callback reads are carried over, `code` and `state`, onto this app's own
 * callback path. The state is sealed by the server and names the person who pressed Connect, so a
 * pasted address can finish only a sign-in that person started, here, in the last ten minutes.
 */

export const CALLBACK_PATH = "/api/plugins/oauth/callback";

export type PastedCallback =
  | { ok: true; path: string }
  | { ok: false; message: string };

export function pastedCallback(pasted: string): PastedCallback {
  const text = pasted.trim();
  if (!text) {
    return {
      ok: false,
      message: tNow("Paste the whole address from your browser."),
    };
  }
  let address: URL;
  try {
    address = new URL(text);
  } catch {
    return {
      ok: false,
      message: tNow(
        "That is not a web address. Copy the whole address from your browser's address bar.",
      ),
    };
  }
  if (!address.pathname.endsWith(CALLBACK_PATH)) {
    return {
      ok: false,
      message: tNow(
        "That is not the address sign-in ends on. It ends in {CALLBACK_PATH}?code=…",
        { CALLBACK_PATH: CALLBACK_PATH },
      ),
    };
  }
  const error = address.searchParams.get("error");
  if (error) {
    return {
      ok: false,
      message:
        error === "access_denied"
          ? tNow(
              "The sign-in was declined in the browser, so nothing was connected. Press Connect to try again.",
            )
          : tNow(
              "The sign-in did not finish in the browser, so nothing was connected. Press Connect to try again.",
            ),
    };
  }
  const code = address.searchParams.get("code");
  const state = address.searchParams.get("state");
  if (!code || !state) {
    return {
      ok: false,
      message: tNow(
        "That address is missing part of the sign-in. Copy the whole address, including everything after the question mark.",
      ),
    };
  }
  const query = new URLSearchParams({ code, state });
  return { ok: true, path: `${CALLBACK_PATH}?${query.toString()}` };
}
