import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { tNow, sentenceNow } = await import("./i18n");
const { LanguageSwitch } = await import("./LanguageSwitch");

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("EN / ΕΛ: each named in its own language, and the choice is kept for the app (#108)", () => {
  const view = render(<LanguageSwitch />);
  expect(
    view.getByRole("button", { name: "English" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(view.getByRole("button", { name: "Ελληνικά" }));
  expect(localStorage.getItem("arkagent.setup.language")).toBe("el");
  expect(
    view.getByRole("button", { name: "Ελληνικά" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(tNow("Set up ArkAgent")).toBe("Ρύθμιση του ArkAgent");
  expect(document.documentElement.lang).toBe("el");
});

test("what the engine says is shown in Greek, values and all (#108)", () => {
  localStorage.setItem("arkagent.setup.language", "el");
  expect(sentenceNow("Downloading ArkAgent 0.1.36.")).toBe(
    "Λήψη του ArkAgent 0.1.36.",
  );
  expect(
    sentenceNow(
      "Port 3010 for the app became unavailable. Try Start again so ArkAgent can choose another local port.",
    ),
  ).toBe(
    "Η θύρα 3010 για το app δεν είναι πλέον διαθέσιμη. Δοκιμάστε ξανά Εκκίνηση ώστε το ArkAgent να επιλέξει άλλη τοπική θύρα.",
  );
});
