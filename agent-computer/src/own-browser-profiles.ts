/**
 * Each digital employee's tab in the person's own browser (device control, phase 1).
 *
 * The same shape as `createProfiles`, so `index.ts` serves both the same way, with the differences
 * that come from whose browser this is:
 *
 *  - ONE BROWSER, THE PERSON'S, ON THEIR SCREEN. The installed Chrome or Edge, started with the
 *    dedicated ArkAgent profile the desktop chose (see own-browser.ts for why over a pipe). It is a
 *    window the person can watch, type into and close.
 *  - A TAB PER EMPLOYEE, AND ONLY ITS OWN. The other tabs are the person's, and other employees'. An
 *    employee follows a window its own tab opened (a sign-in popup) and nothing else: the container's
 *    version follows any new page in the context, which here would hand an employee the tab the
 *    person just opened for themselves. Stopping an employee closes its tab, never the browser.
 *  - CLOSING THE WINDOW IS SWITCHING IT OFF. The person closing the browser is the plainest "stop"
 *    there is, so it is not answered by opening it again on the next action: `onBrowserGone` is
 *    told, and `index.ts` exits, which the desktop reads as the switch going off.
 *  - NO PRIVATE ADDRESSES. Every request is checked, not only the address an employee was told to
 *    open (finding 1; see own-browser.ts).
 */

import { type BrowserContext, chromium, type Page } from "playwright";
import { settleWithin } from "./env";
import { chooseLivePage } from "./live-page";
import {
  isPrivateDestination,
  OWN_BROWSER_HAS_NO_RESET,
  OWN_BROWSER_IGNORED_DEFAULT_ARGS,
  type OwnBrowserSettings,
} from "./own-browser";
import type { BrowserClosed, ProfileSummary } from "./profiles";

/** The size an employee's tab is drawn at, so a person's click on the live screen lands where they meant. */
export const OWN_BROWSER_VIEWPORT = { width: 1280, height: 800 };

const ANNOUNCE_BUDGET_MS = 2_000;

/** Start the person's browser on the dedicated profile. Injectable so a test can count launches. */
export type LaunchOwnBrowser = (
  settings: OwnBrowserSettings,
) => Promise<BrowserContext>;

const launchInstalledBrowser: LaunchOwnBrowser = (settings) =>
  chromium.launchPersistentContext(settings.profileDir, {
    executablePath: settings.executable,
    headless: settings.headless,
    ignoreDefaultArgs: OWN_BROWSER_IGNORED_DEFAULT_ARGS,
    // The person's computer has the sandbox Chromium expects; a container is what lacks it.
    chromiumSandbox: true,
    // The window's own size. Each employee's tab sets its own below.
    viewport: null,
    // This process owns shutdown, as in profiles.ts.
    handleSIGTERM: false,
    handleSIGINT: false,
    handleSIGHUP: false,
  });

export function createOwnBrowserProfiles(
  settings: OwnBrowserSettings,
  onClosed: BrowserClosed,
  onBrowserGone: () => void,
  launch: LaunchOwnBrowser = launchInstalledBrowser,
) {
  type Tab = {
    /** The tab the employee opened, and any window it opened since, newest last. */
    pages: Page[];
    page: Page;
    startedAt: string;
  };

  let browser: Promise<BrowserContext> | undefined;
  /** Set when this process closes the browser, so that close is not read as the person's. */
  let closingOurselves = false;
  const tabs = new Map<string, Tab>();
  const starting = new Map<string, Promise<Page>>();

  /**
   * Refuse every request to the person's own network, whatever asked for it.
   *
   * On the whole ArkAgent profile rather than on each employee's tab, so a window a page opens is
   * covered from its first request instead of from the moment it was noticed, and a tab the person
   * opens in this profile follows the same rule as the one an employee is working in. The profile is
   * ArkAgent's; the person's everyday profile is a different folder and is untouched.
   */
  const guard = async (context: BrowserContext): Promise<void> => {
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (isPrivateDestination(url)) {
        console.info(
          JSON.stringify({
            type: "own-browser-private-address-refused",
            // The host only: a path can carry a token.
            host: new URL(url).host,
          }),
        );
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
  };

  /**
   * The person's browser, started once.
   *
   * A failed start is not remembered, for the reason the sandbox provider gives: one bad moment must
   * not fail every action until a restart. A browser the person closed is a different matter and is
   * handled by `onBrowserGone`, not by starting another.
   */
  const started = (): Promise<BrowserContext> => {
    if (browser) return browser;
    const opening = launch(settings)
      .then(async (context) => {
        await guard(context);
        context.on("close", () => {
          tabs.clear();
          if (closingOurselves) return;
          console.info(
            JSON.stringify({ type: "own-browser-closed-by-person" }),
          );
          onBrowserGone();
        });
        return context;
      })
      .catch((error: unknown) => {
        if (browser === opening) browser = undefined;
        throw new Error(
          `The person's own browser could not be started. (${error instanceof Error ? error.message : String(error)})`,
        );
      });
    browser = opening;
    return opening;
  };

  const adopt = (tab: Tab, page: Page): void => {
    tab.pages.push(page);
    tab.page = chooseLivePage(tab.pages) ?? page;
    page.on("popup", (opened) => adopt(tab, opened));
    page.on("close", () => {
      tab.page = chooseLivePage(tab.pages) ?? tab.page;
    });
  };

  const close = async (botId: string): Promise<boolean> => {
    const tab = tabs.get(botId);
    if (!tab) return false;
    tabs.delete(botId);
    console.info(JSON.stringify({ type: "own-browser-tab-closed", botId }));
    await settleWithin(Promise.resolve(onClosed(botId)), ANNOUNCE_BUDGET_MS);
    await Promise.all(
      tab.pages.map((page) => page.close().catch(() => undefined)),
    );
    return true;
  };

  return {
    /** Open the window now, so switching the setting on shows the person the browser it means. */
    async warm(): Promise<void> {
      await started();
    },

    async page(botId: string): Promise<Page> {
      const opening = starting.get(botId);
      if (opening) return opening;
      const existing = tabs.get(botId);
      if (existing) {
        existing.page = chooseLivePage(existing.pages) ?? existing.page;
        if (!existing.page.isClosed()) return existing.page;
        // The person closed the employee's tab. That is a stop, and the next action opens a fresh one.
        tabs.delete(botId);
      }
      const work = (async () => {
        const context = await started();
        const page = await context.newPage();
        await page.setViewportSize(OWN_BROWSER_VIEWPORT);
        const tab: Tab = {
          pages: [],
          page,
          startedAt: new Date().toISOString(),
        };
        adopt(tab, page);
        tabs.set(botId, tab);
        return tab.page;
      })();
      starting.set(botId, work);
      try {
        return await work;
      } finally {
        starting.delete(botId);
      }
    },

    async stop(botId: string): Promise<boolean> {
      await settleWithin(starting.get(botId), 10_000);
      return close(botId);
    },

    async reset(_botId: string): Promise<void> {
      throw new Error(OWN_BROWSER_HAS_NO_RESET);
    },

    async known(): Promise<string[]> {
      return [...tabs.keys()].sort();
    },

    summary(botIds: string[]): ProfileSummary[] {
      const known = new Set([...botIds, ...tabs.keys()]);
      return [...known].sort().map((botId) => {
        const tab = tabs.get(botId);
        return {
          botId,
          running: Boolean(tab),
          startedAt: tab?.startedAt ?? null,
          // The person's own connection, not a proxy of ours.
          egress: null,
        };
      });
    },

    /** On the way out: close the employees' tabs, then the browser this process started. */
    async closeAll(): Promise<void> {
      await Promise.all([...tabs.keys()].map((botId) => close(botId)));
      const context = await browser?.catch(() => undefined);
      closingOurselves = true;
      await context?.close().catch(() => undefined);
    },

    liveCount(): number {
      return tabs.size;
    },

    isLive(botId: string): boolean {
      return tabs.has(botId);
    },

    async sweepIdleNow(): Promise<void> {},
  };
}
