import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  HeldConfiguration,
  ModelChoice,
  Provider,
} from "./ProviderPicker";

const providers: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    summary: "Use ChatGPT.",
    logins: ["api-key"],
    mark: null,
    caution: null,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    summary: "Use Claude.",
    logins: ["api-key"],
    mark: null,
    caution: null,
  },
];

const endpointProviders: Provider[] = [
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    summary: "Use your own endpoint.",
    logins: ["endpoint"],
    mark: null,
    caution: null,
  },
];

const cloudProviders = [
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    keyUrl: "https://console.x.ai/",
  },
];

const allProviders: Provider[] = [
  ...providers,
  ...cloudProviders.map(
    (provider): Provider => ({
      id: provider.id,
      name: provider.name,
      summary: "Use an API key.",
      logins: ["endpoint"],
      mark: null,
      caution: null,
    }),
  ),
  ...endpointProviders,
];

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

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
}));

const { ProviderPicker } = await import("./ProviderPicker");

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

async function renderPicker(onChoose: (choice: unknown) => void = () => {}) {
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(
      <ProviderPicker
        chosen={null}
        held={{}}
        root=" /tmp/openbot-provider-root "
        onBack={() => {}}
        onChoose={onChoose}
      />,
    );
  });

  return view;
}

async function renderPickerWithHeld(
  held: HeldConfiguration,
  onChoose: (choice: unknown) => void = () => {},
) {
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(
      <ProviderPicker
        chosen={null}
        held={held}
        root=" /tmp/openbot-provider-root "
        onBack={() => {}}
        onChoose={onChoose}
      />,
    );
  });

  return view;
}

for (const provider of providers) {
  test(`${provider.name} API-key choice submits its intentionally typed key`, async () => {
    const choices: unknown[] = [];
    invokeHandler = async (command) => {
      if (command === "providers") return providers;
      throw new Error(`unexpected command ${command}`);
    };
    const view = await renderPicker((choice) => choices.push(choice));
    await userEvent.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    await userEvent.type(
      view.getByLabelText(`${provider.name} API key`),
      `  sk-synthetic-${provider.id}-intentional  `,
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));

    expect(choices).toEqual([
      {
        provider: provider.id,
        login: "api-key",
        apiKey: `sk-synthetic-${provider.id}-intentional`,
      },
    ]);
  });
}

test("a compatible endpoint does not inherit a saved OpenAI API key", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld(
    {
      OPENAI_API_KEY: "sk-synthetic-openai",
      saved: {
        modelApiKeys: {
          openai: true,
          anthropic: false,
        },
      },
    },
    (choice) => choices.push(choice),
  );

  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
  expect(choices[0]).not.toHaveProperty("apiKey");
});

test("a compatible endpoint submits the key typed into its endpoint key field", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld(
    {
      OPENAI_API_KEY: "sk-synthetic-openai",
      saved: {
        modelApiKeys: {
          openai: true,
          anthropic: false,
        },
      },
    },
    (choice) => choices.push(choice),
  );

  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  await userEvent.type(
    view.getByLabelText("API key, if the endpoint needs one"),
    "endpoint-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    apiKey: "endpoint-key",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
});

test("a compatible endpoint carries an optional container-only URL", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld({}, (choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "http://127.0.0.1:11434/v1",
  );
  await userEvent.type(
    view.getByLabelText("Container Base URL, if different"),
    "http://ollama:11434/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "qwen3-vl:2b");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "http://127.0.0.1:11434/v1",
      containerBaseUrl: "http://ollama:11434/v1",
      model: "qwen3-vl:2b",
    },
  ]);
});

test("a compatible endpoint uses the host URL for containers when no override is entered", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld({}, (choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  expect(
    view.getByText(
      /Leave this empty unless containers need a different address/,
    ),
  ).toBeTruthy();
  await userEvent.type(view.getByLabelText("Model name"), "remote-model");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://models.example/v1",
      model: "remote-model",
    },
  ]);
});

test("a compatible endpoint refuses an invalid container-only URL", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld({}, (choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "http://127.0.0.1:11434/v1",
  );
  await userEvent.type(
    view.getByLabelText("Container Base URL, if different"),
    "ollama:11434/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "qwen3-vl:2b");

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(choices).toEqual([]);
});

test.each([
  "http://",
  "https://",
  "httpx://models.example/v1",
  "httpfoo://models.example/v1",
  "https://exa mple.example/v1",
])("a compatible endpoint refuses invalid HTTP(S) URL %s", async (baseUrl) => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker((choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(view.getByLabelText("Base URL"), baseUrl);
  await userEvent.type(view.getByLabelText("Model name"), "local-model");

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(choices).toEqual([]);
});

test("a compatible endpoint accepts local http and external https URLs", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  for (const baseUrl of [
    "http://localhost:11434/v1",
    "https://models.example/v1",
  ]) {
    const view = await renderPicker((choice) => choices.push(choice));
    await userEvent.click(
      await view.findByRole("radio", { name: /OpenAI-compatible/ }),
    );
    await userEvent.type(view.getByLabelText("Base URL"), baseUrl);
    await userEvent.type(view.getByLabelText("Model name"), "local-model");

    const continueButton = view.getByRole("button", { name: "Continue" });
    expect(continueButton).toHaveProperty("disabled", false);
    await userEvent.click(continueButton);
    cleanup();
  }

  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
    },
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://models.example/v1",
      model: "local-model",
    },
  ]);
});

for (const provider of providers) {
  test(`unknown legacy ${provider.id} api-key reuse is explicit and provider scoped`, async () => {
    const choices: unknown[] = [];
    invokeHandler = async (command) => {
      if (command === "providers") return providers;
      throw new Error(`unexpected protected command ${command}`);
    };
    const view = await renderPicker((choice) => choices.push(choice));
    await userEvent.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-unselected-new-key",
    );
    await userEvent.click(
      view.getByRole("button", {
        name: `Use a saved ${provider.name} API key`,
      }),
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices).toEqual([
      { provider: provider.id, login: "api-key", saved: true },
    ]);
    const other = providers.find((item) => item.id !== provider.id)!;
    await userEvent.click(
      view.getByRole("radio", { name: new RegExp(other.name) }),
    );
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);
  });
}

test("a plan sign-in recorded by an older version is not restored, and no plan can be chosen", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    throw new Error(`unexpected protected command ${command}`);
  };
  const choices: unknown[] = [];
  const view = await renderPickerWithHeld(
    {
      saved: {
        // What an older version wrote. It is read as nothing chosen rather than as a plan.
        model: "claude-plan" as never,
        modelApiKeys: { anthropic: true, openai: true },
      },
    },
    (choice) => choices.push(choice),
  );
  expect(await view.findByRole("radio", { name: /Anthropic/ })).toHaveProperty(
    "checked",
    false,
  );
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.queryByRole("tab", { name: /plan/i })).toBeNull();
  expect(view.queryByText(/Sign in with/)).toBeNull();
  expect(choices).toEqual([]);
  expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);
});

test("a saved compatible endpoint restores public fields and requests its scoped key", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected protected command ${command}`);
  };
  const user = userEvent.setup({ document });
  const choices: unknown[] = [];
  const view = await renderPickerWithHeld(
    {
      OPENAI_BASE_URL: "https://models.example/v1",
      OPENAI_CONTAINER_BASE_URL: "http://ollama:11434/v1",
      BOT_MODEL: "local-model",
      saved: {
        model: "compatible-endpoint",
        modelApiKeys: { compatible: true },
      },
    },
    (choice) => choices.push(choice),
  );
  expect(await view.findByLabelText("Base URL")).toHaveProperty(
    "value",
    "https://models.example/v1",
  );
  expect(view.getByLabelText("Model name")).toHaveProperty(
    "value",
    "local-model",
  );
  expect(
    view.getByLabelText("API key, if the endpoint needs one"),
  ).toHaveProperty("value", "");
  expect(view.getByText(/A saved API key for this endpoint/)).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://models.example/v1",
      containerBaseUrl: "http://ollama:11434/v1",
      model: "local-model",
      saved: true,
    },
  ]);
  expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);

  await user.clear(view.getByLabelText("Base URL"));
  await user.type(view.getByLabelText("Base URL"), "https://other.example/v1");
  expect(view.queryByText(/A saved API key for this endpoint/)).toBeNull();
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices[1]).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://other.example/v1",
    model: "local-model",
  });
});

test("saved endpoint key can be explicitly replaced or omitted", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected protected command ${command}`);
  };
  const user = userEvent.setup({ document });
  const choices: unknown[] = [];
  const held: HeldConfiguration = {
    OPENAI_BASE_URL: "https://models.example/v1",
    BOT_MODEL: "local-model",
    saved: {
      model: "compatible-endpoint",
      modelApiKeys: { compatible: true },
    },
  };
  const view = await renderPickerWithHeld(held, (choice) =>
    choices.push(choice),
  );
  await view.findByLabelText("Base URL");
  await user.type(
    view.getByLabelText("API key, if the endpoint needs one"),
    "synthetic-new-key",
  );
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices[0]).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
    apiKey: "synthetic-new-key",
  });
  view.unmount();
  const reopened = await renderPickerWithHeld(held, (choice) =>
    choices.push(choice),
  );
  await user.click(
    await reopened.findByRole("button", {
      name: "Continue without the saved key",
    }),
  );
  await user.click(reopened.getByRole("button", { name: "Continue" }));
  expect(choices[1]).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
});

test("a saved keyless endpoint never requests a saved first-party key", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected protected command ${command}`);
  };
  const user = userEvent.setup({ document });
  const choices: unknown[] = [];
  const view = await renderPickerWithHeld(
    {
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      BOT_MODEL: "local-model",
      saved: { model: "compatible-endpoint", modelApiKeys: { openai: true } },
    },
    (choice) => choices.push(choice),
  );
  await view.findByLabelText("Base URL");
  expect(view.queryByText(/A saved API key for this endpoint/)).toBeNull();
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
    },
  ]);
});

test("OAuth tab switch cancels a late authorization before opening the browser", async () => {
  let resolveBegin!: (value: unknown) => void;
  invokeHandler = async (command) => {
    if (command === "providers")
      return allProviders.map((row) =>
        row.id === "xai" ? { ...row, logins: ["endpoint", "oauth"] } : row,
      );
    if (command === "begin_model_oauth")
      return new Promise((resolve) => {
        resolveBegin = resolve;
      });
    if (command === "cancel_model_oauth") return null;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("radio", { name: /xAI/ }));
  await user.click(view.getByRole("tab", { name: "Sign in" }));
  await user.click(view.getByRole("button", { name: "Sign in with xAI" }));
  await user.click(view.getByRole("tab", { name: "Use an API key" }));
  await act(async () => {
    resolveBegin({
      attemptId: "late-attempt",
      url: "https://authorization.example.test",
      userCode: null,
    });
  });
  expect(invokeCalls).toContainEqual({
    command: "cancel_model_oauth",
    args: { attemptId: "late-attempt" },
  });
  expect(
    invokeCalls.some((call) => call.command === "plugin:opener|open_url"),
  ).toBe(false);
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
});

for (const provider of cloudProviders) {
  test(`${provider.name} OAuth completes through native storage without exposing tokens`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers")
        return allProviders.map((row) =>
          row.id === provider.id
            ? { ...row, logins: ["endpoint", "oauth"] }
            : row,
        );
      if (command === "begin_model_oauth")
        return {
          attemptId: "synthetic-attempt",
          url: "https://authorization.example.test/approve",
          userCode: "SYNTHETIC",
        };
      if (
        command === "plugin:opener|open_url" ||
        command === "finish_model_oauth"
      )
        return null;
      throw new Error(`unexpected command ${command}`);
    };
    const choices: unknown[] = [];
    const view = await renderPicker((choice) => choices.push(choice));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    await user.click(view.getByRole("tab", { name: "Sign in" }));
    await user.click(
      view.getByRole("button", { name: `Sign in with ${provider.name}` }),
    );
    await view.findByText(`Signed in to ${provider.name}.`);
    await user.click(view.getByRole("button", { name: "Continue" }));
    expect(choices).toEqual([
      {
        provider: provider.id,
        login: "oauth",
        model: provider.model,
        saved: true,
      },
    ]);
    expect(invokeCalls).toContainEqual({
      command: "begin_model_oauth",
      args: { root: "/tmp/openbot-provider-root", provider: provider.id },
    });
    expect(invokeCalls).toContainEqual({
      command: "finish_model_oauth",
      args: { attemptId: "synthetic-attempt" },
    });
  });

  test(`${provider.name} opens its API key page externally without sending entered credentials`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      if (command === "plugin:opener|open_url") return null;
      throw new Error(`unexpected command ${command}`);
    };
    const view = await renderPicker();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    await user.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-private-api-key",
    );
    expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);
    await user.click(
      view.getByRole("link", { name: `Get a ${provider.name} API key` }),
    );
    expect(invokeCalls).toEqual([
      { command: "providers", args: undefined },
      { command: "plugin:opener|open_url", args: { url: provider.keyUrl } },
    ]);
  });

  test(`${provider.name} uses its official endpoint and editable model with an API key`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      throw new Error(`unexpected protected command ${command}`);
    };
    const user = userEvent.setup({ document });
    const choices: unknown[] = [];
    const view = await renderPicker((choice) => choices.push(choice));
    await user.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );

    expect(view.getByLabelText("Model name")).toHaveProperty(
      "value",
      provider.model,
    );
    expect(view.queryByLabelText("Base URL")).toBeNull();
    expect(view.queryByRole("tab", { name: /plan/i })).toBeNull();
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-provider-key",
    );
    await user.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[0]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "synthetic-provider-key",
    });
    await user.clear(view.getByLabelText("Model name"));
    await user.type(
      view.getByLabelText("Model name"),
      "another-compatible-model",
    );
    await user.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[1]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: provider.baseUrl,
      model: "another-compatible-model",
      apiKey: "synthetic-provider-key",
    });
  });

  test(`${provider.name} restores its choice when returning from the next setup step`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      throw new Error(`unexpected protected command ${command}`);
    };
    const chosen: ModelChoice = {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: provider.baseUrl,
      model: "chosen-model",
      apiKey: "synthetic-returning-key",
    };
    const choices: ModelChoice[] = [];
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ProviderPicker
          chosen={chosen}
          held={{}}
          root="/tmp/provider-return"
          onBack={() => {}}
          onChoose={(choice) => choices.push(choice)}
        />,
      );
    });
    expect(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    ).toHaveProperty("checked", true);
    expect(view.getByLabelText(`${provider.name} API key`)).toHaveProperty(
      "value",
      "synthetic-returning-key",
    );
    expect(view.getByLabelText("Model name")).toHaveProperty(
      "value",
      "chosen-model",
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices).toEqual([chosen]);
  });

  test(`${provider.name} recognizes a saved endpoint but never carries its key to another provider`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      throw new Error(`unexpected protected command ${command}`);
    };
    // A trailing slash is an equivalent UI identity, but the saved URL itself must
    // survive unchanged so backend credential matching remains endpoint-scoped.
    const savedUrl = provider.baseUrl.endsWith("/")
      ? provider.baseUrl.slice(0, -1)
      : `${provider.baseUrl}/`;
    const choices: unknown[] = [];
    const view = await renderPickerWithHeld(
      {
        OPENAI_BASE_URL: savedUrl,
        BOT_MODEL: "saved-model",
        saved: {
          model: "compatible-endpoint",
          modelApiKeys: { compatible: true, openai: true },
        },
      },
      (choice) => choices.push(choice),
    );
    expect(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    ).toHaveProperty("checked", true);
    expect(view.getByLabelText(`${provider.name} API key`)).toHaveProperty(
      "value",
      "",
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[0]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: savedUrl,
      model: "saved-model",
      saved: true,
    });

    await userEvent.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-replacement-key",
    );
    const other = cloudProviders.find(
      (candidate) => candidate.id !== provider.id,
    )!;
    await userEvent.click(
      view.getByRole("radio", { name: new RegExp(other.name) }),
    );
    expect(view.getByLabelText(`${other.name} API key`)).toHaveProperty(
      "value",
      "",
    );
    expect(view.queryByText(/A saved API key for this endpoint/)).toBeNull();
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(
      view.getByLabelText(`${other.name} API key`),
      "synthetic-other-key",
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[1]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: other.baseUrl,
      model: other.model,
      apiKey: "synthetic-other-key",
    });
  });
}

const freeProviders: Provider[] = [
  {
    id: "local",
    name: "On this computer",
    summary: "Free and private.",
    logins: ["managed"],
    mark: null,
    caution: null,
    unavailable: null,
  },
  {
    id: "ark-server",
    name: "ArkAgent's server",
    summary: "Nothing to download.",
    logins: [],
    mark: null,
    caution: null,
    unavailable: "Arrives with your ArkAgent account.",
  },
  ...providers,
];

const readyPlan = {
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
  toDownloadBytes: 0,
  ready: true,
  engine: "b11696 (cpu)",
};

test("ArkAgent's server is shown with its reason and cannot be chosen", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return freeProviders;
    if (command === "local_model_plan") return readyPlan;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker();
  const server = (await view.findByRole("radio", {
    name: /ArkAgent's server/,
  })) as HTMLInputElement;
  expect(server.disabled).toBe(true);
  expect(view.getByText("Arrives with your ArkAgent account.")).toBeTruthy();
  const local = view.getByRole("radio", {
    name: /On this computer/,
  }) as HTMLInputElement;
  expect(local.disabled).toBe(false);
});

test("On this computer cannot continue until the model is ready, and then continues with no key or address", async () => {
  const choices: unknown[] = [];
  let plan = { ...readyPlan, ready: false, toDownloadBytes: 5_172_000_000 };
  invokeHandler = async (command) => {
    if (command === "providers") return freeProviders;
    if (command === "local_model_plan") return plan;
    if (command === "local_model_prepare") {
      plan = { ...plan, ready: true };
      return undefined;
    }
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker((choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /On this computer/ }),
  );
  const next = await view.findByRole("button", { name: "Continue" });
  expect((next as HTMLButtonElement).disabled).toBe(true);

  await userEvent.click(
    await view.findByRole("button", { name: "Download 5.2 GB" }),
  );
  await view.findByText(/Ready\. Nothing more to download/);
  expect((next as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(next);
  expect(choices).toEqual([{ provider: "local", login: "managed" }]);
});

test("a model already ready on this computer lets Continue light up straight away", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return freeProviders;
    if (command === "local_model_plan") return readyPlan;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker((choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /On this computer/ }),
  );
  await view.findByText(/Ready\. Nothing more to download/);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(choices).toEqual([{ provider: "local", login: "managed" }]);
});

test("the choice is remembered, and comes back selected", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return freeProviders;
    if (command === "local_model_plan") return readyPlan;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPickerWithHeld({ saved: { model: "local-model" } });
  const local = (await view.findByRole("radio", {
    name: /On this computer/,
  })) as HTMLInputElement;
  expect(local.checked).toBe(true);
});
