import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePacedText } from "@/hooks/use-paced-text";

/**
 * A streaming answer is redrawn a few times a second, not on every piece (DT Lab, Wine24: a long
 * table froze the window and seemed to keep streaming after the answer was complete). What must
 * hold: a finished message shows at once, pieces arriving inside one pace are drawn together, and
 * the last piece always lands.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const PACE = 60;

test("a finished message is drawn at once", () => {
  const { result } = renderHook(() =>
    usePacedText("| a | b |\n|---|---|", PACE),
  );
  expect(result.current).toBe("| a | b |\n|---|---|");
});

test("pieces arriving inside one pace are held, and the latest lands", async () => {
  const { result, rerender } = renderHook(
    ({ text }) => usePacedText(text, PACE),
    { initialProps: { text: "| a" } },
  );
  // Inside the first pace: nothing new is drawn yet, however many pieces arrive.
  act(() => rerender({ text: "| a |" }));
  act(() => rerender({ text: "| a | b" }));
  act(() => rerender({ text: "| a | b |" }));
  expect(result.current).toBe("| a");

  // Within a pace the latest piece shows, never one in between.
  await waitFor(() => expect(result.current).toBe("| a | b |"), {
    timeout: PACE * 4,
  });
});

test("a long stream is drawn far fewer times than it has pieces", async () => {
  let draws = 0;
  const { result, rerender } = renderHook(
    ({ text }) => usePacedText(text, PACE),
    { initialProps: { text: "" } },
  );
  const seen = new Set<string>();
  let text = "";
  for (let piece = 0; piece < 40; piece++) {
    text += `| row ${piece} | ${piece * 3} |\n`;
    act(() => rerender({ text }));
    if (!seen.has(result.current)) {
      seen.add(result.current);
      draws++;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await waitFor(() => expect(result.current).toBe(text), { timeout: PACE * 4 });
  // 40 pieces over ~200 ms at a 60 ms pace: a handful of draws, not 40.
  expect(draws).toBeLessThan(12);
});
