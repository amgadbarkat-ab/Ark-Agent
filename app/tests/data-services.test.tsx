import { expect, test } from "bun:test";
import { DATA_SERVICES } from "@/lib/data-services";
import type { CatalogueItem, PluginServer } from "@/lib/plugins/queries";
import { dataServiceState } from "@/routes/_authed/settings/connected-accounts/index";

/**
 * Where each service on the Connect your Data page stands, decided without drawing anything.
 *
 * The rule that matters: a row says "Connect" only when pressing it would get a person to the vendor.
 * A Connect button with no OAuth client behind it can only fail, so it reads "Needs setup" instead.
 * A `.tsx` file because it imports a route module, which is JSX.
 */

const catalogue = (
  key: string,
  auth: CatalogueItem["auth"] = "user-oauth",
): CatalogueItem => ({
  key,
  title: key,
  vendor: "Vendor",
  summary: "",
  docsUrl: "https://example.com",
  auth,
  perInstance: false,
});

const server = (id: string, over: Partial<PluginServer> = {}): PluginServer =>
  ({
    id,
    title: id,
    provenance: "first-party",
    hasCredential: false,
    dynamicClient: false,
    tools: [],
    ...over,
  }) as PluginServer;

const service = (id: string) => {
  const found = DATA_SERVICES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} on the list`);
  return found;
};

const none = new Set<string>();

test("a service nobody has built is not available, whatever the deployment holds", () => {
  expect(
    dataServiceState(service("slack"), {
      catalogue: [catalogue("slack")],
      servers: [server("slack", { hasCredential: true })],
      connected: new Set(["slack"]),
    }),
  ).toEqual({ kind: "not-available" });
});

test("a built connector the deployment does not carry is not available either", () => {
  expect(
    dataServiceState(service("notion"), {
      catalogue: [],
      servers: [],
      connected: none,
    }),
  ).toEqual({ kind: "not-available" });
});

test("a connected account reads as connected", () => {
  expect(
    dataServiceState(service("notion"), {
      catalogue: [catalogue("notion")],
      servers: [server("notion", { dynamicClient: true })],
      connected: new Set(["notion"]),
    }),
  ).toEqual({ kind: "connected" });
});

test("a connector nobody has turned on needs setup, and says what it needs", () => {
  const state = dataServiceState(service("microsoft-365"), {
    catalogue: [catalogue("microsoft-365")],
    servers: [],
    connected: none,
  });
  expect(state.kind).toBe("needs-setup");
  if (state.kind === "needs-setup") {
    expect(state.reason).toContain("Microsoft Entra");
  }
});

test("a connector with no OAuth client behind it cannot be connected, so it needs setup", () => {
  expect(
    dataServiceState(service("google-drive"), {
      catalogue: [catalogue("google-drive")],
      servers: [server("google-drive")],
      connected: none,
    }).kind,
  ).toBe("needs-setup");
});

test("a connector with an OAuth client, or one that registers itself, is ready", () => {
  expect(
    dataServiceState(service("google-drive"), {
      catalogue: [catalogue("google-drive")],
      servers: [server("google-drive", { hasCredential: true })],
      connected: none,
    }),
  ).toEqual({ kind: "ready" });
  expect(
    dataServiceState(service("notion"), {
      catalogue: [catalogue("notion")],
      servers: [server("notion", { dynamicClient: true })],
      connected: none,
    }),
  ).toEqual({ kind: "ready" });
});

test("Microsoft 365 is the one that says it was never tried against a real account", () => {
  expect(
    DATA_SERVICES.filter((candidate) => candidate.untested).map(
      (candidate) => candidate.id,
    ),
  ).toEqual(["microsoft-365"]);
});

test("every service names a connector that exists, or none", () => {
  const builtIn = ["microsoft-365", "google-drive", "notion"];
  for (const candidate of DATA_SERVICES) {
    if (candidate.connector) expect(builtIn).toContain(candidate.connector);
  }
});
