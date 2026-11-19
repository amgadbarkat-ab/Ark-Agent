import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivateServerSection } from "@/components/settings/private-server-section";
import type {
  PrivateServerState,
  ServerTier,
} from "@/lib/private-server/queries";
import { queryClient } from "@/query-client";

/**
 * Settings, then Models, Ark Private Server (#149, 19 Nov): every tier with its storage, the model it
 * suits and its price; "Choose" goes to BlackArk's buy page; an order shows as being set up by
 * BlackArk; a ready server is one click from being the person's model. Held against a fake server.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const tiers: ServerTier[] = [
  {
    id: "small",
    name: "Ark Private Server — Small",
    cpu: "4 vCPU",
    memory: "8 GB RAM",
    gpu: null,
    storage: "100 GB",
    modelSize: "3B",
    models: ["Llama 3.2 3B", "Qwen 2.5 3B"],
    monthlyCents: 950,
    activationCents: 0,
  },
  {
    id: "gpu_entry",
    name: "Ark Private Server — GPU Entry",
    cpu: null,
    memory: "64 GB RAM",
    gpu: "24 GB GPU",
    storage: "~1 TB NVMe",
    modelSize: "14–32B",
    models: [],
    monthlyCents: 35700,
    activationCents: 34800,
  },
];
const BUY = "https://blackark.uk/checkin/buy/?customer=demo-shop&server=";

function serve(state: PrivateServerState, calls: string[] = []) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url, "http://x").pathname}`);
    if (url.endsWith("/api/private-server/connect")) {
      state = { ...state, connected: true };
      return Response.json({ connection: { id: "c1" } });
    }
    return Response.json(state);
  }) as typeof fetch;
}

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <PrivateServerSection />
    </QueryClientProvider>,
  );
}

test("every tier shows its storage, the model it suits and its price, and Choose goes to BlackArk's buy page", async () => {
  serve({
    available: true,
    tiers,
    order: null,
    buyUrl: BUY,
    connected: false,
    error: null,
  });
  const screen = show();
  await screen.findByText("Ark Private Server — Small");
  expect(screen.getByText(/4 vCPU, 8 GB RAM\. Storage: 100 GB\./)).toBeTruthy();
  expect(
    screen.getByText(/Suits 3B models, such as Llama 3\.2 3B, Qwen 2\.5 3B\./),
  ).toBeTruthy();
  expect(screen.getByText("€9.50 a month")).toBeTruthy();
  expect(
    screen.getByText(/24 GB GPU, 64 GB RAM\. Storage: ~1 TB NVMe\./),
  ).toBeTruthy();
  expect(screen.getByText("€357.00 a month")).toBeTruthy();
  expect(screen.getByText(/plus €348\.00 once, to activate/)).toBeTruthy();
  const choose = screen.getAllByRole("button", { name: "Choose" });
  expect(choose.map((link) => link.getAttribute("href"))).toEqual([
    `${BUY}small`,
    `${BUY}gpu_entry`,
  ]);
  expect(choose[0]?.getAttribute("target")).toBe("_blank");
});

test("a paid order shows as being set up by BlackArk, and its tier is marked as yours", async () => {
  serve({
    available: true,
    tiers,
    order: {
      tier: "gpu_entry",
      status: "setting_up",
      orderedAt: "2026-11-19T16:00:00Z",
      paidUntil: "2026-12-19T16:00:00Z",
      readyAt: null,
      baseUrl: null,
      model: null,
    },
    buyUrl: BUY,
    connected: false,
    error: null,
  });
  const screen = show();
  expect((await screen.findByRole("status")).textContent).toContain(
    "BlackArk is setting up your server",
  );
  expect(screen.getByText("Your server")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Choose" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Use this server" })).toBeNull();
});

test("a ready server is one click from being the person's model", async () => {
  const calls: string[] = [];
  serve(
    {
      available: true,
      tiers,
      order: {
        tier: "small",
        status: "ready",
        orderedAt: "2026-11-19T16:00:00Z",
        paidUntil: "2026-12-19T16:00:00Z",
        readyAt: "2026-11-20T09:00:00Z",
        baseUrl: "https://srv-1.example/v1",
        model: "qwen2.5:3b",
      },
      buyUrl: BUY,
      connected: false,
      error: null,
    },
    calls,
  );
  const screen = show();
  const user = userEvent.setup({ document });
  await user.click(
    await screen.findByRole("button", { name: "Use this server" }),
  );
  expect(calls).toContain("POST /api/private-server/connect");
  await waitFor(() =>
    expect(
      screen.getByText(
        /Ready, and your digital employees use it\. Model: qwen2\.5:3b\./,
      ),
    ).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "Use this server" })).toBeNull();
});

test("before activation it says so, and offers nothing to buy", async () => {
  serve({
    available: false,
    tiers: [],
    order: null,
    buyUrl: null,
    connected: false,
    error: null,
  });
  const screen = show();
  await screen.findByText("Activate ArkAgent first to order a private server.");
  expect(screen.queryByRole("button", { name: "Choose" })).toBeNull();
});
