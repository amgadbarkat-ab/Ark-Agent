import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LocalModelPlan } from "./LocalModelPanel";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler: Invoke = async () => {
  throw new Error("invoke handler was not installed");
};
let emit: (payload: unknown) => void = () => {};

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (
    _name: string,
    callback: (event: { payload: unknown }) => void,
  ) => {
    emit = (payload) => callback({ payload });
    return () => {};
  },
}));

const { LocalModelPanel, gigabytes } = await import("./LocalModelPanel");

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  invokeCalls = [];
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

const sixteenGigabytes: LocalModelPlan = {
  ramGib: 15.6,
  cores: 8,
  recommendation: {
    kind: "model",
    model: {
      id: "gemma-4-e4b",
      label: "Gemma 4 E4B",
      sizeBytes: 5_154_941_280,
    },
  },
  toDownloadBytes: 5_172_000_000,
  ready: false,
  engine: "b11696 (cpu)",
};

async function renderPanel(onReady: (ready: boolean) => void = () => {}) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<LocalModelPanel root=" /tmp/ark " onReady={onReady} />);
  });
  return view;
}

test("download sizes are quoted the way downloads are", () => {
  expect(gigabytes(5_154_941_280)).toBe("5.2 GB");
  expect(gigabytes(3_349_516_256)).toBe("3.3 GB");
  expect(gigabytes(14_439_363_584)).toBe("14 GB");
});

test("it says what it found and what it will download, and is not ready until it has", async () => {
  invokeHandler = async (command) => {
    if (command === "local_model_plan") return sixteenGigabytes;
    throw new Error(`unexpected command ${command}`);
  };
  const states: boolean[] = [];
  const view = await renderPanel((ready) => states.push(ready));
  expect(await view.findByText("Gemma 4 E4B")).toBeTruthy();
  expect(view.getByText(/about 16 GB of memory/)).toBeTruthy();
  expect(view.getByRole("button", { name: "Download 5.2 GB" })).toBeTruthy();
  expect(invokeCalls[0]).toEqual({
    command: "local_model_plan",
    args: { root: "/tmp/ark" },
  });
  expect(states.at(-1)).toBe(false);
});

test("it shows the download's progress, can be cancelled, and reports ready when it finishes", async () => {
  let finish!: () => void;
  invokeHandler = async (command) => {
    if (command === "local_model_plan") return sixteenGigabytes;
    if (command === "local_model_prepare") {
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    if (command === "local_model_cancel") return undefined;
    throw new Error(`unexpected command ${command}`);
  };
  const states: boolean[] = [];
  const view = await renderPanel((ready) => states.push(ready));
  await userEvent.click(
    await view.findByRole("button", { name: "Download 5.2 GB" }),
  );
  expect(view.getByText("Starting the download…")).toBeTruthy();

  await act(async () => {
    emit({ stage: "model", downloaded: 1_300_000_000, total: 5_200_000_000 });
  });
  expect(
    view.getByText("Downloading the model: 1.3 GB of 5.2 GB"),
  ).toBeTruthy();
  expect(
    (view.getByLabelText("Download progress") as HTMLProgressElement).value,
  ).toBe(25);

  await userEvent.click(view.getByRole("button", { name: "Cancel download" }));
  expect(
    invokeCalls.some((call) => call.command === "local_model_cancel"),
  ).toBe(true);

  await act(async () => {
    finish();
  });
  expect(
    await view.findByText(/Ready\. Nothing more to download/),
  ).toBeTruthy();
  expect(states.at(-1)).toBe(true);
});

test("a failed download shows the sentence and offers to try again", async () => {
  let attempts = 0;
  invokeHandler = async (command) => {
    if (command === "local_model_plan") return sixteenGigabytes;
    if (command === "local_model_prepare") {
      attempts += 1;
      throw {
        said: "ArkAgent could not reach the download. Check the connection.",
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const states: boolean[] = [];
  const view = await renderPanel((ready) => states.push(ready));
  await userEvent.click(
    await view.findByRole("button", { name: "Download 5.2 GB" }),
  );
  expect(await view.findByText(/could not reach the download/)).toBeTruthy();
  expect(attempts).toBe(1);
  expect(states.at(-1)).toBe(false);
  // The button is back, so the person can try again.
  expect(view.getByRole("button", { name: "Download 5.2 GB" })).toBeTruthy();
});

test("a computer with the model already here is ready at once", async () => {
  invokeHandler = async (command) => {
    if (command === "local_model_plan") {
      return { ...sixteenGigabytes, ready: true, toDownloadBytes: 0 };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const states: boolean[] = [];
  const view = await renderPanel((ready) => states.push(ready));
  expect(
    await view.findByText(/Ready\. Nothing more to download/),
  ).toBeTruthy();
  expect(states.at(-1)).toBe(true);
  expect(view.queryByRole("button", { name: /Download/ })).toBeNull();
});

test("a computer that is too small is told so and cannot continue", async () => {
  invokeHandler = async (command) => {
    if (command === "local_model_plan") {
      return {
        ...sixteenGigabytes,
        ramGib: 4,
        recommendation: {
          kind: "tooSmall",
          said: "This computer has about 4 GB of memory, and the smallest model needs about 8 GB.",
          ramGib: 4,
          needsGib: 7,
        },
        toDownloadBytes: 0,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const states: boolean[] = [];
  const view = await renderPanel((ready) => states.push(ready));
  expect(await view.findByText(/smallest model needs about 8 GB/)).toBeTruthy();
  expect(view.queryByRole("button", { name: /Download/ })).toBeNull();
  expect(states.every((ready) => ready === false)).toBe(true);
});

test("when the computer cannot be read the panel says so", async () => {
  invokeHandler = async (command) => {
    if (command === "local_model_plan") {
      throw {
        said: "ArkAgent could not read how much memory this computer has.",
      };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPanel();
  expect(await view.findByText(/could not read how much memory/)).toBeTruthy();
});
