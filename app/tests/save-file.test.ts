import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { downloadProposalFile } from "@/lib/trial/proposal";

/**
 * Save As for a file the app makes (v0.1.49): inside ArkAgent Desktop the file goes to the desktop's
 * one Save As command, which shows the dialog; in a browser it is an ordinary download, as before.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
});

const file = { name: "proposal-sales.json", text: '{"v":1}' };

test("inside the desktop, the file goes to Save As with its name and text", async () => {
  const calls: { command: string; args: unknown }[] = [];
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    {
      invoke: async (command: string, args: unknown) => {
        calls.push({ command, args });
        return true;
      },
    };
  let clicked = false;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = () => {
    clicked = true;
  };
  try {
    expect(await downloadProposalFile(file)).toBe(true);
  } finally {
    HTMLAnchorElement.prototype.click = click;
  }
  expect(calls).toEqual([
    { command: "plugin:ark-save|save_download", args: file },
  ]);
  expect(clicked).toBe(false);
});

test("a cancelled Save As reports nothing saved", async () => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    { invoke: async () => false };
  expect(await downloadProposalFile(file)).toBe(false);
});

test("in a browser, it is an ordinary download", async () => {
  let clicked = "";
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked = this.download;
  };
  try {
    expect(await downloadProposalFile(file)).toBe(true);
  } finally {
    HTMLAnchorElement.prototype.click = click;
  }
  expect(clicked).toBe("proposal-sales.json");
});
