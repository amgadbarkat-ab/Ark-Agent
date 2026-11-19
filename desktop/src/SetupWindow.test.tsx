import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const calls: string[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    calls.push(command);
    return null;
  },
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
// As App.test.tsx does: the brand marks are a Vite glob, which bun cannot load.
mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
}));

const { cleanup, render } = await import("@testing-library/react");
const { SetupWindow } = await import("./SetupWindow");

afterEach(() => {
  cleanup();
  calls.length = 0;
  localStorage.clear();
});

/**
 * v0.1.50 (Amgad, 16 and 19 Nov): one release for everyone, and nothing trial- or customer-specific
 * in it. The "Import trial profile" button beside EN / ΕΛ (#109, v0.1.37) is gone; a trial profile
 * is loaded by BlackArk staff from the import folder in the setup session (docs/trials/README.md).
 */
test("the setup window offers no trial profile import, in English or Greek", () => {
  const english = render(<SetupWindow />);
  expect(english.getByRole("button", { name: "English" })).toBeTruthy();
  expect(english.queryByText("Import trial profile")).toBeNull();
  expect(english.container.querySelector('input[type="file"]')).toBeNull();
  cleanup();

  localStorage.setItem("arkagent.setup.language", "el");
  const greek = render(<SetupWindow />);
  expect(greek.queryByText("Εισαγωγή προφίλ δοκιμής")).toBeNull();
  expect(greek.container.textContent ?? "").not.toMatch(/arktrial|δοκιμής/i);
  expect(calls).not.toContain("save_trial_profile");
});
