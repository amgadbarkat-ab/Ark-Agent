import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const calls: { command: string; args?: unknown }[] = [];
let answer: (command: string) => Promise<unknown> = async () => null;
mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    calls.push({ command, args });
    return answer(command);
  },
}));

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { TrialImport } = await import("./TrialImport");

afterEach(() => {
  cleanup();
  calls.length = 0;
  localStorage.clear();
});

function choose(view: ReturnType<typeof render>, text: string) {
  const input = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([text], "wine24.arktrial", {
    type: "application/json",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

test("a chosen profile is kept for when the app opens, and the person is told (#109)", async () => {
  const view = render(<TrialImport />);
  choose(view, '{"format":"arktrial/1","profile":"x","signature":"y"}');
  expect(
    await view.findByText(
      "Trial profile ready. It is imported when ArkAgent opens.",
    ),
  ).toBeTruthy();
  expect(calls[0]?.command).toBe("save_trial_profile");
  expect((calls[0]?.args as { text: string }).text).toContain("arktrial/1");
});

test("a refused file says why, in Greek when Greek was chosen (#109)", async () => {
  localStorage.setItem("arkagent.setup.language", "el");
  answer = async () => {
    throw { said: "This file is not a trial profile." };
  };
  const view = render(<TrialImport />);
  expect(view.getByText("Εισαγωγή προφίλ δοκιμής")).toBeTruthy();
  choose(view, "hello");
  expect(
    await view.findByText("Αυτό το αρχείο δεν είναι προφίλ δοκιμής."),
  ).toBeTruthy();
});
