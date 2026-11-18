import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArkLinkState } from "@/lib/ark-link/queries";
import { switchLanguage } from "@/lib/i18n";
import { queryClient } from "@/query-client";
import { Route as PhonesRoute } from "@/routes/_authed/settings/phones";

/**
 * Settings → Phones (#149) against a fake server: who sees it, what it says before it is set up, the
 * code and QR code while pairing, confirming a phone by name, and removing one. In Greek too.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterEach(() => queryClient.clear());
const originalDefaults = queryClient.getDefaultOptions();
afterAll(() => queryClient.setDefaultOptions(originalDefaults));
afterAll(() => GlobalRegistrator.unregister());
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  switchLanguage("en");
});

const OFF: ArkLinkState = {
  configured: false,
  relayUrl: null,
  enabled: false,
  status: "off",
  problem: null,
  noSignIn: false,
  pairing: null,
  devices: [],
};

const PAIRING: ArkLinkState = {
  configured: true,
  relayUrl: "https://link.example",
  enabled: true,
  status: "connected",
  problem: null,
  noSignIn: false,
  pairing: {
    code: "ABCDEFGH",
    display: "ABCD-EFGH",
    url: "https://link.example/_link/pair?code=ABCDEFGH",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    claims: [
      {
        pairingId: "p1",
        deviceName: "Pixel",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    ],
  },
  devices: [
    {
      id: "0b7f9a6e-1111-4222-8333-944455556666",
      name: "Old iPhone",
      pairedAt: "2026-11-01T10:00:00Z",
      lastUsedAt: null,
    },
  ],
};

type Call = { method: string; url: string; body?: unknown };

function serve(
  role: "admin" | "user",
  state: ArkLinkState,
  calls: Call[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith("/api/me"))
      return Response.json({
        user: {
          id: "u1",
          email: "a@example.test",
          role,
          onboarding: null,
          terms: null,
        },
      });
    if (url.endsWith("/api/ark-link") && method === "GET")
      return Response.json(state);
    if (url.includes("/confirm"))
      return Response.json({
        id: "d2",
        name: "x",
        pairedAt: "",
        lastUsedAt: null,
      });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function renderPhones() {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree: createRootRoute({
      component: PhonesRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("only an administrator sees the phones, and nothing is asked of the server for anybody else", async () => {
  const calls: Call[] = [];
  serve("user", OFF, calls);
  const screen = renderPhones();
  await waitFor(() =>
    expect(
      screen.getByText("Only an administrator can pair phones."),
    ).toBeTruthy(),
  );
  expect(calls.some((call) => call.url.includes("/api/ark-link"))).toBe(false);
});

test("before it is set up, it says so, and that pairing is not signing in", async () => {
  serve("admin", OFF);
  const screen = renderPhones();
  await waitFor(() =>
    expect(
      screen.getByText("Not set up. BlackArk gives you an install token."),
    ).toBeTruthy(),
  );
  expect(screen.getByText(/Pairing is not signing in/)).toBeTruthy();
  expect(
    screen.getByText("No phone is paired with this computer."),
  ).toBeTruthy();
  // No pairing while it is off.
  expect(screen.queryByRole("button", { name: /Pair a phone/ })).toBeNull();
});

test("on an install with no sign-in, it says sign-in comes first, in English and in Greek, and offers no way on", async () => {
  serve("admin", { ...OFF, noSignIn: true });
  const screen = renderPhones();
  await screen.findByText(/Phones can be paired only where people sign in/);
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("button", { name: /Pair a phone/ })).toBeNull();
  cleanup();
  queryClient.clear();
  switchLanguage("el");
  serve("admin", { ...PAIRING, noSignIn: true });
  const greek = renderPhones();
  await greek.findByText(/Κινητά συνδέονται μόνο όπου οι χρήστες συνδέονται/);
  expect(greek.queryByTestId("pairing-code")).toBeNull();
});

test("switching it on asks for the relay and the install token first", async () => {
  const calls: Call[] = [];
  serve("admin", OFF, calls);
  const user = userEvent.setup({ document });
  const screen = renderPhones();
  const toggle = await screen.findByRole("switch", { name: "Phone access" });
  await user.click(toggle);
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByLabelText("Install token"),
    "arki_secret",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Save and switch on" }),
  );
  await waitFor(() =>
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      relayUrl: "https://link.blackark.uk",
      enabled: true,
      installToken: "arki_secret",
    }),
  );
});

test("while pairing it shows the code and its QR code, and a person confirms the phone by name", async () => {
  const calls: Call[] = [];
  serve("admin", PAIRING, calls);
  const user = userEvent.setup({ document });
  const screen = renderPhones();
  expect((await screen.findByTestId("pairing-code")).textContent).toBe(
    "ABCD-EFGH",
  );
  expect(
    screen.getByRole("img", { name: "QR code for pairing a phone" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/On an iPhone, type the code in the ArkAgent app/),
  ).toBeTruthy();
  expect(screen.getByText("Pixel")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Confirm" }));
  const dialog = await screen.findByRole("dialog");
  const name = within(dialog).getByLabelText("Phone's name");
  await user.clear(name);
  await user.type(name, "Μαρία's Pixel");
  await user.click(
    within(dialog).getByRole("button", { name: "Pair this phone" }),
  );
  await waitFor(() =>
    expect(calls.find((call) => call.url.includes("/confirm"))).toEqual({
      method: "POST",
      url: "/api/ark-link/pairing/p1/confirm",
      body: { deviceName: "Μαρία's Pixel" },
    }),
  );
});

test("removing a phone asks once, then removes it", async () => {
  const calls: Call[] = [];
  serve("admin", PAIRING, calls);
  const user = userEvent.setup({ document });
  const screen = renderPhones();
  await screen.findByText("Old iPhone");
  expect(screen.getByText(/Not used yet/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === "DELETE")?.url).toBe(
      "/api/ark-link/devices/0b7f9a6e-1111-4222-8333-944455556666",
    ),
  );
});

test("in Greek, the whole screen is Greek", async () => {
  switchLanguage("el");
  serve("admin", PAIRING);
  const screen = renderPhones();
  await screen.findByText("Συνδεδεμένα κινητά");
  expect(screen.getByText("Κινητά")).toBeTruthy();
  expect(screen.getByText("Ζητά σύνδεση. Είναι το κινητό σας;")).toBeTruthy();
  expect(screen.queryByText("Paired phones")).toBeNull();
});
