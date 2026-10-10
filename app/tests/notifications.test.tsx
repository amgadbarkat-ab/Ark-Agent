import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  NotificationSettings,
  testOutcome,
} from "@/components/settings/notifications";
import { applicationServerKey, supportFrom } from "@/lib/push/device";
import { queryClient } from "@/query-client";

/**
 * Notifications on a person's device: what the screen offers on each kind of browser, what it sends
 * the server when switched on, and that a refusal from the server leaves the browser unsubscribed.
 * The browser's own parts (service worker, permission, push manager) are stand-ins here; whether a
 * real push service delivers is checked by hand with real keys.
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
});

const SLOW = { timeout: 5000 };

/** A browser as `supportFrom` sees it, defaulting to desktop Chrome with everything present. */
const browser = (
  overrides: Partial<Parameters<typeof supportFrom>[0]> = {},
) => ({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
  standalone: false,
  hasServiceWorker: true,
  hasPush: true,
  hasNotification: true,
  permission: "default" as NotificationPermission | undefined,
  ...overrides,
});

describe("what this browser can do", () => {
  const iPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605";

  test("a desktop browser with everything present can be subscribed", () => {
    expect(supportFrom(browser())).toBe("ready");
  });

  test("an iPhone in Safari is told to add Ark to the Home Screen, not that it is unsupported", () => {
    // Safari has no push API outside an installed app, so the missing pieces must not decide this.
    expect(
      supportFrom(
        browser({ userAgent: iPhone, hasPush: false, hasNotification: false }),
      ),
    ).toBe("needs-install");
  });

  test("an iPad that calls itself a Mac is recognised by its touch screen", () => {
    expect(
      supportFrom(
        browser({
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          platform: "MacIntel",
          maxTouchPoints: 5,
          hasPush: false,
        }),
      ),
    ).toBe("needs-install");
  });

  test("a real Mac with no touch screen is not mistaken for an iPad", () => {
    expect(
      supportFrom(
        browser({
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          platform: "MacIntel",
          maxTouchPoints: 0,
        }),
      ),
    ).toBe("ready");
  });

  test("an iPhone app opened from the Home Screen can be subscribed", () => {
    expect(supportFrom(browser({ userAgent: iPhone, standalone: true }))).toBe(
      "ready",
    );
  });

  test("a browser without the pieces is unsupported", () => {
    expect(supportFrom(browser({ hasPush: false }))).toBe("unsupported");
    expect(supportFrom(browser({ hasServiceWorker: false }))).toBe(
      "unsupported",
    );
    expect(supportFrom(browser({ hasNotification: false }))).toBe(
      "unsupported",
    );
  });

  test("a site the person blocked is blocked", () => {
    expect(supportFrom(browser({ permission: "denied" }))).toBe("blocked");
  });
});

test("the server's key becomes the bytes a browser wants, URL-safe characters included", () => {
  // 0xfb 0xff 0xfe encodes with both URL-safe replacements: "-" for "+" and "_" for "/".
  const bytes = applicationServerKey("-__-");
  expect(Array.from(bytes)).toEqual([0xfb, 0xff, 0xfe]);
  // Unpadded input is padded, not refused.
  expect(Array.from(applicationServerKey("AQID"))).toEqual([1, 2, 3]);
  expect(Array.from(applicationServerKey("AQI"))).toEqual([1, 2]);
});

test("a test reads as what happened, not as numbers", () => {
  expect(testOutcome({ sent: 1, removed: 0, failed: 0 })).toMatch(/^Sent\./);
  expect(testOutcome({ sent: 2, removed: 0, failed: 0 })).toMatch(
    /Sent to 2 devices/,
  );
  expect(testOutcome({ sent: 0, removed: 1, failed: 0 })).toMatch(
    /no longer accepts/,
  );
  expect(testOutcome({ sent: 0, removed: 0, failed: 1 })).toMatch(
    /did not accept/,
  );
  expect(testOutcome({ sent: 0, removed: 0, failed: 0 })).toMatch(
    /No device is registered/,
  );
});

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const KEYS = { p256dh: "BPublicKeyValueForTesting", auth: "AuthSecretValue" };

type World = {
  /** What the server saw, as "METHOD /path" with the body where there was one. */
  calls: { method: string; path: string; body: unknown }[];
  /** Whether this browser holds a subscription now. */
  subscribed: boolean;
  unsubscribed: number;
  asked: number;
};

/**
 * A browser and a server. `status` is what GET /api/push says; `refuse` makes the server turn a
 * subscription away with its own sentence.
 */
function installWorld(options: {
  status: { enabled: boolean; publicKey: string | null; devices: number };
  userAgent?: string;
  permission?: NotificationPermission;
  grant?: NotificationPermission;
  subscribed?: boolean;
  refuse?: string;
  /** The browser's push service cannot be reached, so subscribing throws. */
  subscribeFails?: boolean;
  testResult?: { sent: number; removed: number; failed: number };
}): World {
  const world: World = {
    calls: [],
    subscribed: options.subscribed ?? false,
    unsubscribed: 0,
    asked: 0,
  };
  const subscription = {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, keys: KEYS }),
    unsubscribe: async () => {
      world.subscribed = false;
      world.unsubscribed += 1;
      return true;
    },
  };
  const registration = {
    pushManager: {
      getSubscription: async () => (world.subscribed ? subscription : null),
      subscribe: async () => {
        if (options.subscribeFails) {
          throw new Error("Registration failed - push service error");
        }
        world.subscribed = true;
        return subscription;
      },
    },
  };
  const define = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { value, configurable: true });

  define(navigator, "serviceWorker", {
    getRegistration: async () => registration,
    register: async () => registration,
    ready: Promise.resolve(registration),
  });
  // Always set, so an iPhone in one test is not still an iPhone in the next.
  define(
    navigator,
    "userAgent",
    options.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0",
  );
  const notification = {
    permission: options.permission ?? "default",
    requestPermission: async () => {
      world.asked += 1;
      return options.grant ?? "granted";
    },
  };
  for (const target of [window, globalThis]) {
    define(target, "PushManager", class {});
    define(target, "Notification", notification);
  }

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    world.calls.push({ method, path, body });
    if (path === "/api/push" && method === "GET") {
      return Response.json(options.status);
    }
    if (path === "/api/push/subscription" && method === "PUT") {
      return options.refuse
        ? Response.json({ error: options.refuse }, { status: 400 })
        : Response.json({ ok: true });
    }
    if (path === "/api/push/subscription" && method === "DELETE") {
      return Response.json({ ok: true });
    }
    if (path === "/api/push/test" && method === "POST") {
      return Response.json(
        options.testResult ?? { sent: 1, removed: 0, failed: 0 },
      );
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as unknown as typeof fetch;
  return world;
}

function renderSettings() {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationSettings />
    </QueryClientProvider>,
  );
}

const ON = { enabled: true, publicKey: "AQIDBAUGBwgJCg", devices: 0 };

test("says an administrator has to switch notifications on, and offers no switch, where the server cannot send", async () => {
  installWorld({ status: { enabled: false, publicKey: null, devices: 0 } });
  const screen = renderSettings();
  await screen.findByText(/Not set up on this server/, {}, SLOW);
  expect(screen.queryByRole("switch") === null).toBe(true);
});

test("tells an iPhone user to add Ark to the Home Screen, and offers no switch", async () => {
  installWorld({
    status: ON,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605",
  });
  const screen = renderSettings();
  await screen.findByText(/add Ark to your Home Screen/, {}, SLOW);
  expect(screen.queryByRole("switch") === null).toBe(true);
});

test("says a blocked site has to be allowed in the browser, and offers no switch", async () => {
  installWorld({ status: ON, permission: "denied" });
  const screen = renderSettings();
  await screen.findByText(/blocked for this site/, {}, SLOW);
  expect(screen.queryByRole("switch") === null).toBe(true);
});

test("switching on asks permission, subscribes, and sends the server only the subscription", async () => {
  const world = installWorld({ status: ON });
  const screen = renderSettings();
  const toggle = await screen.findByRole("switch", {}, SLOW);
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(toggle);

  await waitFor(
    () =>
      expect(
        world.calls.some(
          (c) => c.method === "PUT" && c.path.endsWith("/subscription"),
        ),
      ).toBe(true),
    SLOW,
  );
  expect(world.asked).toBe(1);
  const put = world.calls.find((c) => c.method === "PUT");
  expect(put?.body).toEqual({ endpoint: ENDPOINT, keys: KEYS });
  // The row now says it is on, and the test row appears.
  await screen.findByText("Send a test", {}, SLOW);
  expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe(
    "true",
  );
});

test("a server that refuses the subscription leaves this browser unsubscribed and says why", async () => {
  const world = installWorld({
    status: ON,
    refuse: "That address is not one this server sends notifications to.",
  });
  const screen = renderSettings();
  fireEvent.click(await screen.findByRole("switch", {}, SLOW));

  await screen.findByText(
    /not one this server sends notifications to/,
    {},
    SLOW,
  );
  expect(world.unsubscribed).toBe(1);
  expect(world.subscribed).toBe(false);
  expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe(
    "false",
  );
});

test("a person who says no to the browser's prompt is told, and nothing is sent", async () => {
  const world = installWorld({ status: ON, grant: "denied" });
  const screen = renderSettings();
  fireEvent.click(await screen.findByRole("switch", {}, SLOW));

  await screen.findByText(/blocked for this site/, {}, SLOW);
  expect(world.calls.some((c) => c.method === "PUT")).toBe(false);
});

test("switching off tells the server which device, then lets go of the subscription", async () => {
  const world = installWorld({ status: ON, subscribed: true });
  const screen = renderSettings();
  const toggle = await screen.findByRole("switch", {}, SLOW);
  await waitFor(
    () => expect(toggle.getAttribute("aria-checked")).toBe("true"),
    SLOW,
  );

  fireEvent.click(toggle);

  await waitFor(() => expect(world.unsubscribed).toBe(1), SLOW);
  const removal = world.calls.find((c) => c.method === "DELETE");
  expect(removal?.body).toEqual({ endpoint: ENDPOINT });
  await waitFor(
    () =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    SLOW,
  );
  expect(screen.queryByText("Send a test") === null).toBe(true);
});

test("a test says whether it was sent", async () => {
  const world = installWorld({
    status: ON,
    subscribed: true,
    testResult: { sent: 1, removed: 0, failed: 0 },
  });
  const screen = renderSettings();
  fireEvent.click(await screen.findByRole("button", { name: "Send" }, SLOW));
  await screen.findByText(/Sent\. It should arrive/, {}, SLOW);
  expect(
    world.calls.some((c) => c.method === "POST" && c.path === "/api/push/test"),
  ).toBe(true);
});

test("a browser that cannot reach its notification service says so in plain words", async () => {
  const world = installWorld({ status: ON, subscribeFails: true });
  const screen = renderSettings();
  fireEvent.click(await screen.findByRole("switch", {}, SLOW));

  await screen.findByText(
    /could not register with its notification service/,
    {},
    SLOW,
  );
  // The browser's own wording is not shown, and the server was never asked to remember anything.
  expect(screen.queryByText(/Registration failed/) === null).toBe(true);
  expect(world.calls.some((c) => c.method === "PUT")).toBe(false);
  expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe(
    "false",
  );
});
