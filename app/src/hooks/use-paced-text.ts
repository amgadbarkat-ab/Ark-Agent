import { useEffect, useRef, useState } from "react";

/** How often, at most, a streaming answer is drawn again. */
export const PACE_MS = 150;

/**
 * `text`, but changing at most once every `paceMs`, and always ending on the latest value.
 *
 * A streaming answer arrives a few characters at a time, and drawing markdown again on every piece
 * re-parses the whole answer each time. For a long table that is quadratic: a 120-row price list was
 * 839 redraws and 14 seconds of rendering, single redraws over 150 ms (DT Lab, Wine24). The window
 * froze while it streamed, and when the model had finished the screen was still working through the
 * pieces it had queued, so the answer seemed to keep streaming after it was complete.
 *
 * Paced, the answer is drawn a few times a second whatever the size of each piece, and the last
 * value always lands within one pace of arriving. A finished message is drawn at once: the first
 * value is never held back.
 */
export function usePacedText(text: string, paceMs: number = PACE_MS): string {
  const [shown, setShown] = useState(text);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    if (text === shown) return;
    const wait = shownAt.current + paceMs - Date.now();
    const show = () => {
      shownAt.current = Date.now();
      setShown(text);
    };
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [text, shown, paceMs]);

  return shown;
}
