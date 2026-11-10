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

/** Widgets that read letter keys themselves (type-ahead in a menu or list, arrows in tabs). */
const KEYBOARD_WIDGETS =
  '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="combobox"]';

function inKeyboardWidget(element: Element | null): boolean {
  return element instanceof HTMLElement && !!element.closest(KEYBOARD_WIDGETS);
}

/** Keys that act on a focused button or link: never taken from one. */
const PRESSES = new Set([" ", "Enter"]);

function isPressable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.tagName === "BUTTON" ||
    element.tagName === "A" ||
    element.getAttribute("role") === "button" ||
    element.getAttribute("role") === "link"
  );
}

/**
 * Typing with the caret nowhere goes into the message box, first character included (desk #73).
 *
 * Back with Alt+Tab, a person types at once: before the window-returned signal above has moved the
 * caret, so the first word was lost ("test ", DT Lab, v0.1.25). Here a printable key that arrives
 * while nothing editable has the caret moves it to the message box during that same keystroke, and
 * the browser then writes the character there. Shortcuts (Ctrl, Cmd, Alt), keys that are not
 * characters, Space or Enter on a focused button, and keys inside a menu, list or tabs are left
 * alone, as is everything while a dialog is open or the person is in another field.
 */
export function useTypeToFocus(focus: () => void, enabled = true) {
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1) return;
      if (PRESSES.has(event.key) && isPressable(document.activeElement)) return;
      if (inKeyboardWidget(document.activeElement)) return;
      if (!shouldTakeFocus()) return;
      focusRef.current();
    };
    // Capture, so the caret has moved before anything else on the page reads the keystroke.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
