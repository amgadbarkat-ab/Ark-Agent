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

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
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

const models = [
  {
    id: "gemma-4-26b-a4b",
    label: "Gemma 4 26B A4B",
    sizeBytes: 14_439_363_584,
    recommended: true,
    ready: false,
  },
  {
    id: "gemma-4-12b",
    label: "Gemma 4 12B",
    sizeBytes: 6_975_879_296,
    recommended: false,
    ready: false,
  },
  {
    id: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    sizeBytes: 5_154_941_280,
    recommended: false,
    ready: false,
  },
];

const thirtyTwoGigabytes: LocalModelPlan = {
  ramGib: 31.7,
  cores: 16,
  gpu: true,
  recommendation: {
    kind: "model",
    model: {
      id: "gemma-4-26b-a4b",
      label: "Gemma 4 26B A4B",
      sizeBytes: 14_439_363_584,
    },
  },
  models,
  chosen: "gemma-4-26b-a4b",
  toDownloadBytes: 14_460_000_000,
  ready: false,
  engine: "b11696 (vulkan)",
};

async function renderPanel(
  props: Partial<{
    chosen: string | null;
    onChoose: (id: string) => void;
    onReady: (ready: boolean) => void;
  }> = {},
) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <LocalModelPanel
        root=" /tmp/ark "
        chosen={props.chosen ?? null}
        onChoose={props.onChoose ?? (() => {})}
        onReady={props.onReady ?? (() => {})}
      />,
    );
  });
  return view;
}

test("download sizes are quoted the way downloads are", () => {
  expect(gigabytes(5_154_941_280)).toBe("5.2 GB");
  expect(gigabytes(3_349_516_256)).toBe("3.3 GB");
  expect(gigabytes(14_439_363_584)).toBe("14 GB");
});

test("it offers every model this computer can run, with the best chosen for the person", async () => {
  invokeHandler = async (command) => {
    if (command === "local_model_plan") return thirtyTwoGigabytes;
    throw new Error(`unexpected command ${command}`);
  };
  const chosen: string[] = [];
  const ready: boolean[] = [];
  const view = await renderPanel({
    onChoose: (id) => chosen.push(id),
    onReady: (value) => ready.push(value),
  });
  expect(await view.findByText("Gemma 4 26B A4B")).toBeTruthy();
  expect(view.getByText("Gemma 4 12B")).toBeTruthy();
  expect(view.getByText("Gemma 4 E4B")).toBeTruthy();
  expect(
    view.getByText(/about 32 GB of memory and a graphics card/),
  ).toBeTruthy();
  expect(view.getByText("Recommended for this computer")).toBeTruthy();
  expect(view.getByText(/Best for agents/)).toBeTruthy();
  // The first look makes the choice for them, and nothing is downloaded from here.
  expect(chosen).toEqual(["gemma-4-26b-a4b"]);
  expect(ready.at(-1)).toBe(true);
  expect(invokeCalls[0]).toEqual({
    command: "local_model_plan",
    args: { root: "/tmp/ark", model: null },
  });
  expect(
    invokeCalls.some((call) => call.command === "local_model_prepare"),
  ).toBe(false);
});

test("it says the download happens during setup and how big it is", async () => {
  invokeHandler = async () => thirtyTwoGigabytes;
  const view = await renderPanel();
  expect(
    await view.findByText(/downloads 14 GB while it installs, once/),
  ).toBeTruthy();
  expect(view.getByText(/Your graphics card is used/)).toBeTruthy();
  expect(view.queryByRole("button", { name: /Download/ })).toBeNull();
});

test("choosing another model reports it, and the figures follow the choice", async () => {
  invokeHandler = async (_command, args) => {
    const asked = (args as { model?: string | null }).model;
    return asked === "gemma-4-e4b"
      ? {
          ...thirtyTwoGigabytes,
          chosen: "gemma-4-e4b",
          toDownloadBytes: 5_200_000_000,
        }
      : thirtyTwoGigabytes;
  };
  const picked: string[] = [];
  const view = await renderPanel({ onChoose: (id) => picked.push(id) });
  await userEvent.click(
    await view.findByRole("radio", { name: /Gemma 4 E4B/ }),
  );
  expect(picked.at(-1)).toBe("gemma-4-e4b");
  // The parent holds the choice and gives it back; the panel asks about it.
  view.rerender(
    <LocalModelPanel
      root=" /tmp/ark "
      chosen="gemma-4-e4b"
      onChoose={() => {}}
      onReady={() => {}}
    />,
  );
  expect(
    await view.findByText(/downloads 5.2 GB while it installs/),
  ).toBeTruthy();
  expect(
    invokeCalls.some(
      (call) =>
        (call.args as { model?: string | null } | undefined)?.model ===
        "gemma-4-e4b",
    ),
  ).toBe(true);
});

test("a model already on this computer says there is nothing to download", async () => {
  invokeHandler = async () => ({
    ...thirtyTwoGigabytes,
    ready: true,
    toDownloadBytes: 0,
    models: models.map((model, index) =>
      index === 0 ? { ...model, ready: true } : model,
    ),
  });
  const view = await renderPanel();
  expect(
    await view.findByText(
      /already on this computer, so there is nothing to download/,
    ),
  ).toBeTruthy();
  expect(view.getAllByText("Already on this computer").length).toBeGreaterThan(
    0,
  );
});

test("a computer too small for any model is told so, and cannot continue", async () => {
  invokeHandler = async () => ({
    ramGib: 4,
    cores: 2,
    gpu: false,
    recommendation: {
      kind: "tooSmall",
      said: "This computer has about 4 GB of memory, and the smallest model needs about 8 GB. Use ArkAgent's server or your own key instead.",
      ramGib: 4,
      needsGib: 7,
    },
    models: [],
    chosen: null,
    toDownloadBytes: 0,
    ready: false,
    engine: "b11696 (cpu)",
  });
  const ready: boolean[] = [];
  const view = await renderPanel({ onReady: (value) => ready.push(value) });
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(view.getByText(/smallest model needs about 8 GB/)).toBeTruthy();
  expect(ready.every((value) => value === false)).toBe(true);
});

test("a computer that cannot be read is a failure the person can see", async () => {
  invokeHandler = async () => {
    throw {
      said: "ArkAgent could not look at this computer.",
      detail: "no memory figure",
    };
  };
  const view = await renderPanel();
  expect(
    await view.findByText("ArkAgent could not look at this computer."),
  ).toBeTruthy();
});
