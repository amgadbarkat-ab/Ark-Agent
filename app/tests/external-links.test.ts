import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { externalAddress, installExternalLinks } from "@/lib/external-links";

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
});

function link(href: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.textContent = "Get a key";
  document.body.append(anchor);
  return anchor;
}

function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  anchor.dispatchEvent(event);
  return event;
}

test("another website is an external address, this one and non-web addresses are not", () => {
  const here = "http://127.0.0.1:3010/settings/models";
  const of = (href: string) => {
    const anchor = document.createElement("a");
    anchor.href = href;
    return externalAddress(anchor, here);
  };
  expect(of("https://openrouter.ai/keys")).toBe("https://openrouter.ai/keys");
  expect(of("/settings/plan")).toBeNull();
  expect(of("mailto:support@example.com")).toBeNull();
  expect(of("http://insecure.example/")).toBeNull();
});

test("inside the desktop window a link to another website opens in the browser", () => {
  const opened: Array<{ command: string; args: unknown }> = [];
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    {
      invoke: async (command: string, args: unknown) => {
        opened.push({ command, args });
      },
    };
  installExternalLinks();
  const event = click(link("https://openrouter.ai/keys"));
  expect(event.defaultPrevented).toBe(true);
  expect(opened).toEqual([
    {
      command: "plugin:opener|open_url",
      args: { url: "https://openrouter.ai/keys" },
    },
  ]);
});

test("in an ordinary browser the link is left alone", () => {
  installExternalLinks();
  const event = click(link("https://openrouter.ai/keys"));
  expect(event.defaultPrevented).toBe(false);
});

test("a link inside the app, or one opened with a modifier key, is left alone", () => {
  const opened: unknown[] = [];
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    { invoke: async (...call: unknown[]) => opened.push(call) };
  installExternalLinks();
  expect(click(link("#plan")).defaultPrevented).toBe(false);
  expect(
    click(link("https://openrouter.ai/keys"), { ctrlKey: true })
      .defaultPrevented,
  ).toBe(false);
  expect(opened).toEqual([]);
});
