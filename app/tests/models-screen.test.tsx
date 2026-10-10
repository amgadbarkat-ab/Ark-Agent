import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ModelCatalogue,
  ModelConnection,
  ModelProvider,
} from "@/lib/models/queries";
import { Route as ModelsRoute } from "@/routes/_authed/settings/models";

/**
 * The Models screen is where a person decides what their coworkers think with, and the thing it must
 * never do is show a key, or say "no model is connected" about a list that failed to load. Both are
 * easy to get wrong and invisible when they are, so they are held here against a fake server.
 *
 * Same harness as the other screens: `GlobalRegistrator` around the file, `cleanup` after each test,
 * and a client with `retry: false` so a failed read settles at once.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ollama: ModelProvider = {
  id: "ollama",
  name: "Ollama",
  tier: "local",
  baseUrlEditable: true,
  baseUrl: "http://localhost:11434/v1",
  keyRequired: false,
  suggestedModels: ["llama3.2"],
  summary: "Runs on your computer. Free.",
};
const anthropic: ModelProvider = {
  id: "anthropic",
  name: "Anthropic (Claude)",
  tier: "paid",
  baseUrlEditable: false,
  baseUrl: "https://api.anthropic.com",
  keyRequired: true,
  suggestedModels: ["claude-haiku-4-5-20251001"],
  summary: "Your own Anthropic key.",
};
const subscription: ModelProvider = {
  id: "chatgpt-plan",
  name: "ChatGPT plan",
  tier: "plan",
  baseUrlEditable: false,
  baseUrl: "",
  keyRequired: false,
  suggestedModels: [],
  summary: "Sign in with a ChatGPT plan.",
  unavailable: "Not allowed until the provider approves Ark.",
};

function catalogue(providers: ModelProvider[]): ModelCatalogue {
  return { providers, localModels: [] };
}

function connection(overrides: Partial<ModelConnection>): ModelConnection {
  return {
    id: "c1",
    providerId: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-4-5-20251001",
    isDefault: true,
    hasKey: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Answers the two reads the screen makes; anything else is a failure. */
function serve(options: {
  providers: ModelCatalogue;
  connections: ModelConnection[] | "fail";
  coworkers?: Array<{ id: string; name: string }>;
  choices?: Array<{ botId: string; connectionId: string }>;
  puts?: Array<{ url: string; body: unknown }>;
}) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agents")) {
      return Response.json({ agents: options.coworkers ?? [] });
    }
    if (url.includes("/api/models/bots")) {
      if (init?.method === "PUT") {
        options.puts?.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({});
      }
      return Response.json({ choices: options.choices ?? [] });
    }
    if (url.endsWith("/api/models/providers")) {
      return Response.json(options.providers);
    }
    if (url.endsWith("/api/models/connections")) {
      return options.connections === "fail"
        ? new Response(null, { status: 500 })
        : Response.json({ connections: options.connections });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderModels() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: ModelsRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const SLOW = { timeout: 5000 };

beforeEach(() => {
  serve({ providers: catalogue([ollama, anthropic]), connections: [] });
});

test("says so when no model is connected", async () => {
  const screen = renderModels();
  expect(
    await screen.findByText(/No model is connected/, {}, SLOW),
  ).toBeTruthy();
});

test("lists a saved model with its provider and that a key is saved, never the key", async () => {
  serve({
    providers: catalogue([ollama, anthropic]),
    connections: [connection({ label: "Work Claude" })],
  });
  const screen = renderModels();
  expect(await screen.findByText("Work Claude", {}, SLOW)).toBeTruthy();
  expect(screen.getByText("Default")).toBeTruthy();
  expect(
    screen.getByText(
      "Anthropic (Claude) · claude-haiku-4-5-20251001 · key saved",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/sk-/);
});

test("does not repeat the provider's name when the person never renamed the model", async () => {
  serve({
    providers: catalogue([ollama, anthropic]),
    connections: [connection({})],
  });
  const screen = renderModels();
  expect(await screen.findByText("Anthropic (Claude)", {}, SLOW)).toBeTruthy();
  expect(
    screen.getByText("claude-haiku-4-5-20251001 · key saved"),
  ).toBeTruthy();
});

test("a failed load is an error, not an empty list", async () => {
  serve({ providers: catalogue([ollama]), connections: "fail" });
  const screen = renderModels();
  expect(await screen.findByRole("alert", {}, SLOW)).toBeTruthy();
  expect(screen.queryByText(/No model is connected/)).toBeNull();
});

test("explains a provider that is not offered instead of hiding it", async () => {
  serve({
    providers: catalogue([ollama, subscription]),
    connections: [],
  });
  const screen = renderModels();
  expect(await screen.findByText("Not available", {}, SLOW)).toBeTruthy();
  expect(screen.getByText(subscription.unavailable as string)).toBeTruthy();
});

test("Add model opens the form once the providers have loaded", async () => {
  const screen = renderModels();
  const add = await screen.findByRole("button", { name: /Add model/ }, SLOW);
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  await userEvent.setup({ document }).click(add);
  expect(await screen.findByText(/Test connection/, {}, SLOW)).toBeTruthy();
});

test("a coworker can be pointed at another model, once there is more than one to choose from", async () => {
  const puts: Array<{ url: string; body: unknown }> = [];
  serve({
    providers: catalogue([ollama, anthropic]),
    connections: [
      connection({ id: "c1", label: "Work Claude" }),
      connection({
        id: "c2",
        providerId: "ollama",
        label: "On my laptop",
        isDefault: false,
        hasKey: false,
      }),
    ],
    coworkers: [{ id: "analyst", name: "Analyst" }],
    puts,
  });
  const screen = renderModels();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("combobox", { name: "Model for Analyst" }, SLOW),
  );
  await user.click(await screen.findByRole("option", { name: "On my laptop" }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]?.url).toContain("/api/models/bots/analyst");
  expect(puts[0]?.body).toEqual({ connectionId: "c2" });
});

test("shows no coworker section when there is only one model to use", async () => {
  serve({
    providers: catalogue([ollama, anthropic]),
    connections: [connection({ id: "c1", label: "Work Claude" })],
    coworkers: [{ id: "analyst", name: "Analyst" }],
  });
  const screen = renderModels();
  expect(await screen.findByText("Work Claude", {}, SLOW)).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: /Model for/ })).toBeNull();
});
