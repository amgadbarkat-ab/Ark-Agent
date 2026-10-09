import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { AccountOverview } from "@/lib/account/queries";
import { markdownComponents } from "@/lib/markdown";
import {
  forgetOpener,
  IOS_USER_AGENT_TOKEN,
  isPurchaseLink,
  openedByFrom,
  purchasesAllowedFor,
} from "@/lib/store-app";
import { queryClient } from "@/query-client";
import { Route as PlanRoute } from "@/routes/_authed/settings/plan";

/**
 * Inside a store app nothing may sell, price, or point to somewhere to buy (docs/ark/19-mobile.md).
 * The same pages serve everyone, so these hold the one place that decides, and the screens that obey it.
 *
 * What matters: the website is never mistaken for an app (a prospective customer must be able to buy),
 * another Android app opening the site is not mistaken for Ark's own, and inside the app the plan
 * screen and the server's offers to upgrade say what the account has and no more.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL("https://ark.example/settings/plan");
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
const ANDROID_PACKAGE = "com.example.ark";
const WEB_USER_AGENT = "Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile";

const define = (target: object, name: string, value: unknown) =>
  Object.defineProperty(target, name, { value, configurable: true });

/** Open a page the way a store app, another app, or the website would. */
function openedBy(options: { userAgent?: string; referrer?: string }) {
  forgetOpener();
  window.sessionStorage.clear();
  define(navigator, "userAgent", options.userAgent ?? WEB_USER_AGENT);
  define(document, "referrer", options.referrer ?? "");
}
beforeEach(() => openedBy({}));

describe("which page opened this visit", () => {
  const memory = (referrer: string, kept: string | null = null) => {
    const state = { kept };
    return {
      state,
      source: {
        referrer,
        read: () => state.kept,
        write: (value: string) => {
          state.kept = value;
        },
      },
    };
  };

  test("an Android app that opened the page is named by its package, and remembered for the visit", () => {
    const { source, state } = memory(`android-app://${ANDROID_PACKAGE}`);
    expect(openedByFrom(source)).toBe(ANDROID_PACKAGE);
    expect(state.kept).toBe(ANDROID_PACKAGE);
  });

  test("the address can carry the page it was opened at", () => {
    expect(
      openedByFrom(
        memory(`android-app://${ANDROID_PACKAGE}/https/ark.example/channel/1`)
          .source,
      ),
    ).toBe(ANDROID_PACKAGE);
  });

  test("a sign-in round trip does not forget it: the next page's referrer is the identity provider's", () => {
    expect(
      openedByFrom(
        memory("https://accounts.google.com/", ANDROID_PACKAGE).source,
      ),
    ).toBe(ANDROID_PACKAGE);
  });

  test("a page opened by a website, or by nothing, was not opened by an app", () => {
    expect(openedByFrom(memory("").source)).toBeNull();
    expect(
      openedByFrom(memory("https://news.example/story").source),
    ).toBeNull();
    expect(openedByFrom(memory("android-app://").source)).toBeNull();
  });
});

describe("whether a way to buy may be shown", () => {
  const allowed = (input: {
    userAgent?: string;
    openedBy?: string | null;
    androidPackage?: string | null | undefined;
  }) =>
    purchasesAllowedFor({
      userAgent: input.userAgent ?? WEB_USER_AGENT,
      openedBy: input.openedBy ?? null,
      androidPackage: input.androidPackage,
    });

  test("the website sells, with or without the server having answered", () => {
    expect(allowed({})).toBe(true);
    expect(allowed({ androidPackage: ANDROID_PACKAGE })).toBe(true);
    expect(allowed({ androidPackage: null })).toBe(true);
  });

  test("the iOS app never sells, whatever else is true", () => {
    const userAgent = `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}`;
    expect(allowed({ userAgent })).toBe(false);
    expect(allowed({ userAgent, androidPackage: ANDROID_PACKAGE })).toBe(false);
  });

  test("the Android app never sells", () => {
    expect(
      allowed({ openedBy: ANDROID_PACKAGE, androidPackage: ANDROID_PACKAGE }),
    ).toBe(false);
  });

  test("another Android app opening the site is only the website", () => {
    expect(
      allowed({
        openedBy: "com.google.android.googlequicksearchbox",
        androidPackage: ANDROID_PACKAGE,
      }),
    ).toBe(true);
    // A deployment with no Android app has nothing for any Android app to be.
    expect(allowed({ openedBy: ANDROID_PACKAGE, androidPackage: null })).toBe(
      true,
    );
  });

  test("while the server has not said, an Android app that opened the page is assumed to be Ark's", () => {
    expect(allowed({ openedBy: ANDROID_PACKAGE })).toBe(false);
  });
});

describe("a link to the plan page", () => {
  test("is one whether it is written as a path or as this site's address, with or without a query", () => {
    expect(isPurchaseLink("/settings/plan")).toBe(true);
    expect(isPurchaseLink("/settings/plan?paid=1")).toBe(true);
    expect(isPurchaseLink("https://ark.example/settings/plan")).toBe(true);
  });

  test("is not a link to anything else, or to somebody else's page of that name", () => {
    expect(isPurchaseLink("/settings/privacy")).toBe(false);
    expect(isPurchaseLink("/settings/plans")).toBe(false);
    expect(isPurchaseLink("https://elsewhere.example/settings/plan")).toBe(
      false,
    );
    expect(isPurchaseLink(undefined)).toBe(false);
  });
});

const Link = markdownComponents.a;

describe("the server's offers to upgrade, inside a message", () => {
  const offer = () => (
    <p>
      I will start as soon as one finishes.{" "}
      <Link href="/settings/plan">
        To run more at once, upgrade to Ark Team (€100 a month).
      </Link>
    </p>
  );

  test("are links on the website", () => {
    const screen = render(offer());
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "/settings/plan",
    );
    expect(screen.getByText(/upgrade to Ark Team/)).toBeTruthy();
  });

  test("are left out of the iOS app, with the rest of the message", () => {
    openedBy({ userAgent: `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}` });
    const screen = render(offer());
    expect(screen.queryByRole("link") === null).toBe(true);
    expect(screen.queryByText(/upgrade/) === null).toBe(true);
    expect(screen.queryByText(/€/) === null).toBe(true);
    expect(
      screen.getByText(/I will start as soon as one finishes/),
    ).toBeTruthy();
  });

  test("other links in the same message are left alone", () => {
    openedBy({ userAgent: `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}` });
    const screen = render(
      <p>
        <Link href="https://example.org/docs">The docs</Link>
      </p>,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://example.org/docs",
    );
  });
});

const account = (
  over: Partial<AccountOverview["account"]> = {},
): AccountOverview => ({
  account: {
    tenantId: "t1",
    tenantName: "ann@example.com",
    planId: "team",
    planName: "Ark Team",
    subscriptionStatus: "active",
    maxActiveBots: 15,
    canRun: true,
    activeBots: 1,
    currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...over,
  },
  billing: { mode: "subscriptions", provider: "paddle", selfService: true },
  plans: [
    {
      id: "agent",
      name: "Ark Agent",
      priceEurCents: 5000,
      maxActiveBots: 3,
      summary: "For one person.",
    },
    {
      id: "team",
      name: "Ark Team",
      priceEurCents: 10000,
      maxActiveBots: 15,
      summary: "For a busy person.",
    },
  ],
});

function serve(overview: AccountOverview, androidPackage: string | null) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/capabilities")) {
      return Response.json({ generativeUi: false, androidPackage });
    }
    if (url.endsWith("/api/account/cloud")) {
      return new Response(null, { status: 404 });
    }
    if (url.endsWith("/api/account")) return Response.json(overview);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function renderPlan() {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree: createRootRoute({
      component: PlanRoute.options.component as never,
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("the plan screen", () => {
  test("on the website offers the plans, with their prices, and billing", async () => {
    serve(account(), ANDROID_PACKAGE);
    const screen = renderPlan();
    expect(await screen.findByText("Plans", {}, SLOW)).toBeTruthy();
    expect(screen.getByText("Ark Agent")).toBeTruthy();
    expect(screen.getAllByText(/€50 a month/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Choose Ark Agent" }),
    ).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
  });

  test("in the iOS app says what the account has and offers nothing to buy or change", async () => {
    openedBy({ userAgent: `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}` });
    serve(account(), ANDROID_PACKAGE);
    const screen = renderPlan();
    expect(await screen.findByText("Your plan", {}, SLOW)).toBeTruthy();
    expect(screen.getByText("Ark Team")).toBeTruthy();
    expect(screen.getByText("1 of 15 working now")).toBeTruthy();
    for (const gone of [
      /€/,
      /a month/,
      /Choose/,
      /Billing/,
      /Cancel/,
      /Cloud/,
    ]) {
      expect(screen.queryByText(gone) === null).toBe(true);
    }
    expect(screen.queryByRole("button") === null).toBe(true);
  });

  test("in the Android app, once the server confirms it is Ark's own, the same", async () => {
    openedBy({ referrer: `android-app://${ANDROID_PACKAGE}` });
    serve(account(), ANDROID_PACKAGE);
    const screen = renderPlan();
    expect(await screen.findByText("Your plan", {}, SLOW)).toBeTruthy();
    // Give the server's answer every chance to arrive and change its mind.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText("Plans") === null).toBe(true);
    expect(screen.queryByText(/€/) === null).toBe(true);
  });

  test("opened by another Android app, it is the website and sells", async () => {
    openedBy({
      referrer: "android-app://com.google.android.googlequicksearchbox",
    });
    serve(account(), ANDROID_PACKAGE);
    const screen = renderPlan();
    expect(await screen.findByText("Plans", {}, SLOW)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose Ark Agent" }),
    ).toBeTruthy();
  });

  test("in the app, an account with no plan is told so, and not to choose one", async () => {
    openedBy({ userAgent: `${WEB_USER_AGENT} ${IOS_USER_AGENT_TOKEN}` });
    serve(
      account({
        canRun: false,
        planId: "none",
        planName: "No plan",
        subscriptionStatus: "incomplete",
        blockedCode: "no_plan",
        blockedReason: "Choose a plan to start your digital employees.",
      }),
      null,
    );
    const screen = renderPlan();
    await waitFor(
      () =>
        expect(
          screen.getAllByText("This account does not have an active plan.")
            .length,
        ).toBeGreaterThan(0),
      SLOW,
    );
    expect(screen.queryByText(/Choose/) === null).toBe(true);
    expect(screen.queryByText("Plans") === null).toBe(true);
  });

  test("on the website, the same account is told to choose one", async () => {
    serve(
      account({
        canRun: false,
        planId: "none",
        planName: "No plan",
        subscriptionStatus: "incomplete",
        blockedCode: "no_plan",
        blockedReason: "Choose a plan to start your digital employees.",
      }),
      null,
    );
    const screen = renderPlan();
    expect(
      (
        await screen.findAllByText(
          "Choose a plan to start your digital employees.",
          {},
          SLOW,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
