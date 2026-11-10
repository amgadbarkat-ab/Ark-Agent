import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import {
  useFocusOnReturn,
  useTypeToFocus,
  WINDOW_RETURNED,
} from "@/hooks/use-focus-on-return";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";

/**
 * DT Lab, v0.1.24 (desk #73): the window restored from the taskbar, typing started, and the first six
 * characters were lost until the message box was clicked. The caret now goes back to the box when
 * the window returns, unless the person had it somewhere else they can type, or a dialog is open.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function Composer({ enabled = true }: { enabled?: boolean }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useFocusOnReturn(() => box.current?.focus(), enabled);
  return (
    <div>
      <textarea aria-label="message" ref={box} />
      <input aria-label="search" />
      <button type="button">elsewhere</button>
    </div>
  );
}

const returned = (event = WINDOW_RETURNED) =>
  act(() => {
    window.dispatchEvent(new Event(event));
  });

test("the desktop's window-returned signal puts the caret in the message box", async () => {
  const view = render(<Composer />);
  (view.getByText("elsewhere") as HTMLButtonElement).focus();
  returned();
  await waitFor(() =>
    expect(document.activeElement).toBe(view.getByLabelText("message")),
  );
});

test("so does the browser's own window focus", async () => {
  const view = render(<Composer />);
  returned("focus");
  await waitFor(() =>
    expect(document.activeElement).toBe(view.getByLabelText("message")),
  );
});

test("a person typing in another field keeps the caret there", async () => {
  const view = render(<Composer />);
  const search = view.getByLabelText("search") as HTMLInputElement;
  search.focus();
  returned();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).toBe(search);
});

test("an open dialog keeps what it had", async () => {
  const view = render(
    <>
      <Composer />
      <div role="dialog" data-state="open">
        <button type="button">ok</button>
      </div>
    </>,
  );
  returned();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).not.toBe(view.getByLabelText("message"));
});

test("a composer that cannot take input does not take the caret", async () => {
  const view = render(<Composer enabled={false} />);
  returned();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(document.activeElement).not.toBe(view.getByLabelText("message"));
});

function Typist({ onNewChat = () => {} }: { onNewChat?: () => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useTypeToFocus(() => box.current?.focus());
  useHotkey("new-chat", onNewChat);
  return (
    <div>
      <textarea aria-label="message" ref={box} />
      <input aria-label="search" />
      <button type="button">elsewhere</button>
      <div role="menu">
        <button type="button" role="menuitem">
          Rename
        </button>
      </div>
    </div>
  );
}

test("after Alt+Tab, typing with the caret nowhere lands in the message box, first word included", async () => {
  const view = render(<Typist />);
  (view.getByText("elsewhere") as HTMLButtonElement).focus();
  (document.activeElement as HTMLElement).blur();
  await userEvent.setup({ document }).keyboard("test word");
  const box = view.getByLabelText("message") as HTMLTextAreaElement;
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("test word");
});

test("a capital N on its way to the message box is a letter, not a new chat", async () => {
  let newChats = 0;
  const view = render(<Typist onNewChat={() => newChats++} />);
  await userEvent.setup({ document }).keyboard("Ναι, Nikos");
  expect((view.getByLabelText("message") as HTMLTextAreaElement).value).toBe(
    "Ναι, Nikos",
  );
  expect(newChats).toBe(0);
});

test("another field, a shortcut, a menu and Space on a button keep their keys", async () => {
  const view = render(<Typist />);
  const box = view.getByLabelText("message") as HTMLTextAreaElement;
  const search = view.getByLabelText("search") as HTMLInputElement;
  search.focus();
  await userEvent.setup({ document }).keyboard("abc");
  expect(search.value).toBe("abc");

  (view.getByText("elsewhere") as HTMLButtonElement).focus();
  await userEvent.setup({ document }).keyboard(" ");
  await userEvent.setup({ document }).keyboard("{Control>}k{/Control}");
  expect(document.activeElement).toBe(view.getByText("elsewhere"));

  (view.getByRole("menuitem") as HTMLButtonElement).focus();
  await userEvent.setup({ document }).keyboard("r");
  expect(document.activeElement).toBe(view.getByRole("menuitem"));
  expect(box.value).toBe("");
});
