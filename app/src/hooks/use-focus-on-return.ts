import { useEffect, useRef } from "react";

/**
 * Sent by the desktop app into the page whenever its window becomes the active one again (desk #73).
 *
 * The page cannot always tell for itself: restored from the taskbar, the window is active while the
 * web view inside it has not been told, so neither `focus` nor `visibilitychange` fires and the
 * keyboard goes nowhere. DT Lab lost the first six characters typed that way ("The qu").
 */
export const WINDOW_RETURNED = "arkagent:window-returned";

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

/**
 * Whether the caret should go to the message box now: nothing the person can type into has it, and no
 * dialog is open over the conversation. A person who had the caret in another field gets it back
 * there from the browser, and a dialog keeps what it had.
 */
export function shouldTakeFocus(doc: Document = document): boolean {
  if (doc.visibilityState === "hidden") return false;
  if (isEditable(doc.activeElement)) return false;
  return !doc.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [aria-modal="true"]',
  );
}

/**
 * Calls `focus` when the window comes back to the person, if `shouldTakeFocus` says the caret is
 * free. After the browser has restored its own focus, so a field it puts the caret back into wins.
 */
export function useFocusOnReturn(focus: () => void, enabled = true) {
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const returned = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (shouldTakeFocus()) focusRef.current();
      }, 0);
    };
    const visible = () => {
      if (document.visibilityState === "visible") returned();
    };
    window.addEventListener("focus", returned);
    window.addEventListener(WINDOW_RETURNED, returned);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", returned);
      window.removeEventListener(WINDOW_RETURNED, returned);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled]);
}
