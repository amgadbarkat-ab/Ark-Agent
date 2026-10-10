import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ParticleMark } from "@/components/brand/particle-mark";

/**
 * The animation is decoration: where nothing can draw it (here, a test browser with no WebGL), the card
 * must still be a card with the company's tile in it, and it must not be announced to anyone.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

test("without WebGL the card keeps the company's tile and is hidden from assistive technology", () => {
  const view = render(<ParticleMark className="h-40 w-full" />);
  const card = view.container.firstElementChild as HTMLElement;
  expect(card.getAttribute("aria-hidden")).toBe("true");
  expect(card.dataset.particles).toBe("off");
  // The tile is still there to look at, and no half-made canvas is left behind.
  expect(card.querySelector("svg rect[fill='#FF7A1A']") === null).toBe(false);
  expect(card.querySelector("canvas") === null).toBe(true);
});

test("takes the size it is given", () => {
  const view = render(<ParticleMark className="h-40 w-full" />);
  const card = view.container.firstElementChild as HTMLElement;
  expect(card.className).toContain("h-40");
  expect(card.className).toContain("w-full");
});
