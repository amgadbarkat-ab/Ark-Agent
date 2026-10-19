/**
 * Links to other websites, opened in the person's own browser when this page is inside ArkAgent Desktop.
 *
 * In an ordinary browser a link with `target="_blank"` just works. Inside the desktop window it does
 * nothing: the window is a web view with one page in it, and a request for a second window has nowhere
 * to go. "Get a key" on the Models screen, and every other link to somebody else's site, looked dead.
 *
 * The window can ask the desktop to open an address in the default browser, and nothing else: the
 * permission the desktop grants this page names that one command and web addresses only. In a browser
 * there is no desktop to ask, so this does nothing and the link behaves as it always did.
 */

type Opener = (
  command: string,
  args: { url: string },
) => Promise<unknown> | undefined;

function desktopOpener(): Opener | null {
  if (typeof window === "undefined") return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ as { invoke?: Opener } | undefined;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
}

/** The address a click on this should open elsewhere, or null when the page should handle it. */
export function externalAddress(
  anchor: HTMLAnchorElement,
  here: string,
): string | null {
  let url: URL;
  try {
    url = new URL(anchor.href, here);
  } catch {
    return null;
  }
  // Only the web. `mailto:`, `tel:` and in-app addresses are not for another browser.
  if (url.protocol !== "https:") return null;
  return url.origin === new URL(here).origin ? null : url.toString();
}

export function installExternalLinks(): void {
  if (typeof document === "undefined") return;
  // The capture phase, so a link inside a dialog or a menu that stops the click from bubbling still counts.
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const address = externalAddress(
        anchor as HTMLAnchorElement,
        window.location.href,
      );
      const open = desktopOpener();
      if (!address || !open) return;
      event.preventDefault();
      void open("plugin:opener|open_url", { url: address });
    },
    true,
  );
}
