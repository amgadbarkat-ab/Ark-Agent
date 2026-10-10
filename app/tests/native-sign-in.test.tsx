import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  type CompleteDeps,
  completeNativeSignIn,
  FAILED_PATH,
  useNativeSignInReturn,
} from "@/lib/native/listener";
import { exchangeNativeSignInMutationOptions } from "@/lib/native/mutations";
import {
  beginNativeSignIn,
  challengeFor,
  grantFrom,
  MOST_MS,
  type Pending,
  type PendingStore,
  RETURN_HOST,
  randomToken,
} from "@/lib/native/sign-in";
import { IOS_USER_AGENT_TOKEN } from "@/lib/store-app";
import { queryClient } from "@/query-client";
import { Route as SignRoute } from "@/routes/sign";

/**
 * Signing in inside the iOS app, from the app's side.
 *
 * What is protected: the secret that makes a stolen code useless is made from real randomness, kept
 * only on the phone, and only ever sent to the server; an address that is not the answer to the
 * sign-in this app started changes nothing; one answer is one try; and inside the app the sign-in
 * screen offers only what the system-browser page can do.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL("https://ark.example/sign");
});
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
const SCHEME = "arkapp";
const WEB_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605";
const define = (target: object, name: string, value: unknown) =>
  Object.defineProperty(target, name, { value, configurable: true });

function memoryStore(initial: Pending | null = null) {
  const state = { pending: initial };
  const store: PendingStore = {
    read: () => state.pending,
    write: (pending) => {
      state.pending = pending;
    },
    clear: () => {
      state.pending = null;
    },
  };
  return { state, store };
}

const pending: Pending = {
  state: "p".repeat(32),
  verifier: "v".repeat(43),
  startedAt: 1_000,
};
const answer = (over: Record<string, string> = {}) => {
  const query = new URLSearchParams({
    code: "C".repeat(32),
    state: pending.state,
    ...over,
  });
  return `${SCHEME}://${RETURN_HOST}?${query}`;
};

describe("the secret", () => {
  test("is URL-safe text from real randomness, a different one each time", () => {
    const first = randomToken(32);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(first);
    expect(randomToken(24)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test("is turned into the challenge exactly as the server turns it back", async () => {
    const verifier = "v".repeat(43);
    expect(await challengeFor(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(await challengeFor(verifier)).toHaveLength(43);
  });
});

describe("starting a sign-in", () => {
  test("keeps the secret here and gives the browser only the challenge", async () => {
    const { state, store } = memoryStore();
    const opened: string[] = [];
    await beginNativeSignIn({
      provider: "google",
      scheme: SCHEME,
      origin: "https://ark.example",
      open: async (address) => {
        opened.push(address);
      },
      store,
      now: () => 5_000,
    });
    expect(opened).toHaveLength(1);
    const address = new URL(opened[0] as string);
    expect(address.origin + address.pathname).toBe(
      "https://ark.example/api/auth/native",
    );
    expect(address.searchParams.get("provider")).toBe("google");
    expect(address.searchParams.get("redirect_uri")).toBe(
      `${SCHEME}://${RETURN_HOST}`,
    );
    // What the browser is given is the state and the challenge, and not the secret.
    const saved = state.pending as Pending;
    expect(address.searchParams.get("state")).toBe(saved.state);
    expect(address.searchParams.get("code_challenge")).toBe(
      await challengeFor(saved.verifier),
    );
    expect(opened[0]).not.toContain(saved.verifier);
    expect(saved.startedAt).toBe(5_000);
    expect(saved.state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe("an address the app was opened with", () => {
  test("is the answer when it comes back to this app, with this state, soon enough", () => {
    expect(grantFrom(answer(), SCHEME, pending, 2_000)).toEqual({
      code: "C".repeat(32),
      state: pending.state,
      verifier: pending.verifier,
    });
  });

  test("is not, when no sign-in was started or it was started too long ago", () => {
    expect(grantFrom(answer(), SCHEME, null, 2_000)).toBeNull();
    expect(
      grantFrom(answer(), SCHEME, pending, pending.startedAt + MOST_MS + 1),
    ).toBeNull();
    expect(
      grantFrom(answer(), SCHEME, pending, pending.startedAt + MOST_MS),
    ).not.toBeNull();
  });

  test("is not, when it carries the wrong state: the answer to somebody else's sign-in", () => {
    expect(
      grantFrom(answer({ state: "q".repeat(32) }), SCHEME, pending, 2_000),
    ).toBeNull();
    expect(
      grantFrom(
        `${SCHEME}://${RETURN_HOST}?code=${"C".repeat(32)}`,
        SCHEME,
        pending,
        2_000,
      ),
    ).toBeNull();
  });

  test("is not, when it is any other address, scheme, or shape of code", () => {
    for (const address of [
      "",
      "not an address",
      `other://${RETURN_HOST}?code=${"C".repeat(32)}&state=${pending.state}`,
      `https://${RETURN_HOST}?code=${"C".repeat(32)}&state=${pending.state}`,
      `${SCHEME}://elsewhere?code=${"C".repeat(32)}&state=${pending.state}`,
      `${SCHEME}://user@${RETURN_HOST}?code=${"C".repeat(32)}&state=${pending.state}`,
      `${answer()}#frag`,
      answer({ code: "short" }),
      answer({ code: `${"C".repeat(31)}!` }),
      answer({ code: "C".repeat(129) }),
    ]) {
      expect(grantFrom(address, SCHEME, pending, 2_000)).toBeNull();
    }
  });
});

describe("finishing", () => {
  const deps = (over: Partial<CompleteDeps> = {}) => {
    const log: string[] = [];
    const { state, store } = memoryStore(pending);
    const all: CompleteDeps = {
      store,
      exchange: async (grant) => {
        log.push(`exchange ${grant.code} ${grant.verifier}`);
      },
      closeBrowser: async () => {
        log.push("close");
      },
      go: (path) => {
        log.push(`go ${path}`);
      },
      now: () => 2_000,
      ...over,
    };
    return { log, state, all };
  };

  test("an answer is exchanged with the secret, the browser closed, and the app sent home", async () => {
    const { log, state, all } = deps();
    expect(await completeNativeSignIn(answer(), SCHEME, all)).toBe("signed-in");
    expect(log).toEqual([
      `exchange ${"C".repeat(32)} ${pending.verifier}`,
      "close",
      "go /",
    ]);
    expect(state.pending).toBeNull();
  });

  test("an address that is not the answer changes nothing, and the secret stays for the real one", async () => {
    const { log, state, all } = deps();
    expect(
      await completeNativeSignIn(
        answer({ state: "q".repeat(32) }),
        SCHEME,
        all,
      ),
    ).toBe("ignored");
    expect(log).toEqual([]);
    expect(state.pending).toEqual(pending);
  });

  test("one answer is one try: the same address again does nothing", async () => {
    const { log, all } = deps();
    await completeNativeSignIn(answer(), SCHEME, all);
    log.length = 0;
    expect(await completeNativeSignIn(answer(), SCHEME, all)).toBe("ignored");
    expect(log).toEqual([]);
  });

  test("a refused exchange closes the browser and says so on the sign-in screen, and the secret is spent", async () => {
    const { log, state, all } = deps({
      exchange: async () => {
        throw new Error("refused");
      },
    });
    expect(await completeNativeSignIn(answer(), SCHEME, all)).toBe("failed");
    expect(log).toEqual(["close", `go ${FAILED_PATH}`]);
    expect(state.pending).toBeNull();
  });

  test("a browser that will not close does not stop the app finishing", async () => {
    const { log, all } = deps({
      closeBrowser: async () => {
        throw new Error("already closed");
      },
    });
    expect(await completeNativeSignIn(answer(), SCHEME, all)).toBe("signed-in");
    expect(log.at(-1)).toBe("go /");
  });
});

describe("the exchange", () => {
  test("sends the code, the state and the secret to the server, and nothing else", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ token: "x", user: {} });
    }) as unknown as typeof fetch;
    await exchangeNativeSignInMutationOptions(queryClient).mutationFn?.(
      { code: "C".repeat(32), state: "s".repeat(32), verifier: "v".repeat(43) },
      {} as never,
    );
    expect(calls).toEqual([
      {
        url: "/api/auth/electron/token",
        method: "POST",
        body: {
          token: "C".repeat(32),
          state: "s".repeat(32),
          code_verifier: "v".repeat(43),
        },
      },
    ]);
  });

  test("a refusal from the server is an error carrying its own words", async () => {
    global.fetch = (async () =>
      Response.json(
        { message: "Invalid or expired token." },
        { status: 404 },
      )) as unknown as typeof fetch;
    await expect(
      exchangeNativeSignInMutationOptions(queryClient).mutationFn?.(
        {
          code: "C".repeat(32),
          state: "s".repeat(32),
          verifier: "v".repeat(43),
        },
        {} as never,
      ),
    ).rejects.toThrow();
  });
});

describe("the sign-in screen", () => {
  const opened: string[] = [];
  beforeAll(() => {
    mock.module("@capacitor/browser", () => ({
      Browser: {
        open: async ({ url }: { url: string }) => {
          opened.push(url);
        },
        close: async () => undefined,
      },
    }));
  });
  beforeEach(() => {
    opened.length = 0;
    window.localStorage.clear();
  });

  const serve = (capabilities: Record<string, unknown>) => {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/capabilities")) {
        return Response.json({ generativeUi: false, ...capabilities });
      }
      if (url.endsWith("/api/me")) return new Response(null, { status: 401 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
  };

  function renderSign() {
    queryClient.setDefaultOptions({ queries: { retry: false } });
    /*
     * The screen reads its search with `Route.useSearch()`, which asks the router for the match
     * whose id is the route's own. That id is not fixed: it is unset until some router is built over
     * the real route tree and "/sign" from then on, and `app/src/router.tsx` builds one the moment it
     * is imported. Bun runs every test file in one process, so whether this file saw an id depended on
     * which file ran before it, and in CI four of these failed with "Could not find an active match
     * from /sign". A route of this own path and id answers either way.
     */
    const rootRoute = createRootRoute();
    const signRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/sign",
      component: SignRoute.options.component as never,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([signRoute]),
      history: createMemoryHistory({ initialEntries: ["/sign"] }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
  }

  test("in a browser, offers every provider and the company form, as before", async () => {
    define(navigator, "userAgent", WEB_USER_AGENT);
    serve({
      authProviders: ["google", "microsoft", "okta"],
      ssoConfigured: true,
    });
    const screen = renderSign();
    expect(
      await screen.findByRole("button", { name: /Continue with Google/ }, SLOW),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Continue with Okta/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Continue with your company account/,
      }),
    ).toBeTruthy();
  });

  test("in the iOS app, offers only what the browser page can start, and opens it on a tap", async () => {
    define(navigator, "userAgent", `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`);
    serve({
      authProviders: ["google", "microsoft", "okta"],
      ssoConfigured: true,
      appUrlScheme: SCHEME,
    });
    const screen = renderSign();
    const google = await screen.findByRole(
      "button",
      { name: /Continue with Google/ },
      SLOW,
    );
    expect(
      screen.getByRole("button", { name: /Continue with Microsoft/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Okta/ }) === null).toBe(true);
    expect(screen.queryByText(/company account/) === null).toBe(true);

    fireEvent.click(google);
    await waitFor(() => expect(opened).toHaveLength(1), SLOW);
    const address = new URL(opened[0] as string);
    expect(address.pathname).toBe("/api/auth/native");
    expect(address.searchParams.get("provider")).toBe("google");
    expect(address.searchParams.get("redirect_uri")).toBe(
      `${SCHEME}://${RETURN_HOST}`,
    );
    // The secret waits on the phone.
    const kept = JSON.parse(
      window.localStorage.getItem("ark.native-sign-in") as string,
    ) as Pending;
    expect(opened[0]).not.toContain(kept.verifier);
  });

  test("in the iOS app of a deployment that never named its scheme, says so and opens nothing", async () => {
    define(navigator, "userAgent", `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`);
    serve({ authProviders: ["google"], appUrlScheme: null });
    const screen = renderSign();
    fireEvent.click(
      await screen.findByRole("button", { name: /Continue with Google/ }, SLOW),
    );
    await screen.findByText(/not set up in this app yet/, {}, SLOW);
    expect(opened).toHaveLength(0);
  });

  test("in the iOS app of a deployment that only has company sign-in, says it is not available there", async () => {
    define(navigator, "userAgent", `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`);
    serve({
      authProviders: ["okta"],
      ssoConfigured: true,
      appUrlScheme: SCHEME,
    });
    const screen = renderSign();
    await screen.findByText(/not available in the app/, {}, SLOW);
    expect(screen.queryByRole("button") === null).toBe(true);
  });
});

describe("listening for the answer", () => {
  const registered: string[] = [];
  const removed: string[] = [];
  let launchUrl: string | undefined;
  beforeAll(() => {
    mock.module("@capacitor/app", () => ({
      App: {
        addListener: async (name: string) => {
          registered.push(name);
          return { remove: async () => void removed.push(name) };
        },
        getLaunchUrl: async () => (launchUrl ? { url: launchUrl } : undefined),
      },
    }));
  });
  beforeEach(() => {
    registered.length = 0;
    removed.length = 0;
    launchUrl = undefined;
    window.localStorage.clear();
  });

  const serve = (capabilities: Record<string, unknown>) => {
    global.fetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/capabilities")
        ? Response.json({ generativeUi: false, ...capabilities })
        : new Response(null, { status: 404 })) as unknown as typeof fetch;
  };
  const Listener = () => {
    useNativeSignInReturn();
    return null;
  };
  const mount = () => {
    queryClient.setDefaultOptions({ queries: { retry: false } });
    return render(
      <QueryClientProvider client={queryClient}>
        <Listener />
      </QueryClientProvider>,
    );
  };

  test("registers inside the iOS app once the server has named the scheme, and lets go when it goes", async () => {
    define(navigator, "userAgent", `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`);
    serve({ appUrlScheme: SCHEME });
    const view = mount();
    await waitFor(() => expect(registered).toEqual(["appUrlOpen"]), SLOW);
    view.unmount();
    await waitFor(() => expect(removed).toEqual(["appUrlOpen"]), SLOW);
  });

  test("registers nothing in a browser, and nothing where there is no iOS app", async () => {
    define(navigator, "userAgent", WEB_USER_AGENT);
    serve({ appUrlScheme: SCHEME });
    mount();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(registered).toEqual([]);
    cleanup();
    queryClient.clear();

    define(navigator, "userAgent", `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`);
    serve({ appUrlScheme: null });
    mount();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(registered).toEqual([]);
  });

  test("an address the app was launched with that is not an answer is ignored", async () => {
    define(navigator, "userAgent", `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`);
    launchUrl = `${SCHEME}://${RETURN_HOST}?code=${"C".repeat(32)}&state=${"q".repeat(32)}`;
    serve({ appUrlScheme: SCHEME });
    mount();
    await waitFor(() => expect(registered).toEqual(["appUrlOpen"]), SLOW);
    // Nothing was started, so nothing was spent or sent anywhere.
    expect(window.localStorage.getItem("ark.native-sign-in") === null).toBe(
      true,
    );
  });
});
