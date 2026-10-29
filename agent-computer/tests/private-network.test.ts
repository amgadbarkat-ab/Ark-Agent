import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import {
  privateNetworkBlocked,
  refusePrivateNetworkArgs,
  refusePrivateRequests,
} from "../src/private-network";
import { standInBrowser } from "./own-browser-stand-in";

describe("whether the deployment closed the private network", () => {
  test("only an explicit true closes it", () => {
    expect(privateNetworkBlocked({})).toBe(false);
    expect(privateNetworkBlocked({ COMPUTER_BLOCK_PRIVATE_NETWORK: "" })).toBe(
      false,
    );
    expect(
      privateNetworkBlocked({ COMPUTER_BLOCK_PRIVATE_NETWORK: "false" }),
    ).toBe(false);
    expect(
      privateNetworkBlocked({ COMPUTER_BLOCK_PRIVATE_NETWORK: " true " }),
    ).toBe(true);
  });

  test("anything else stops the computer rather than guessing", () => {
    expect(() =>
      privateNetworkBlocked({ COMPUTER_BLOCK_PRIVATE_NETWORK: "yes" }),
    ).toThrow("must be true or false");
  });
});

/**
 * The case the server's rule cannot see (desk #84, step 9): a public page that sends the browser to
 * the router by itself. The public site is played by Playwright's own routing, so nothing here
 * depends on the network, and the private addresses are never reached: each request is refused
 * before it leaves, by the route or by the proxy script, exactly as the computers launch them.
 */
// Run with `bun run test:own-browser`, as the other live browser tests: the ordinary test job does
// not install this package's dependencies, so Playwright is loaded only when the browser part runs.
const asked = process.env.OPENBOT_OWN_BROWSER === "1";
const executable = asked ? standInBrowser() : null;
describe.skipIf(!executable)(
  "a public page cannot send the browser onto the private network",
  () => {
    let browser: Browser;
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        ...(executable ? { executablePath: executable } : {}),
        args: refusePrivateNetworkArgs(),
      });
      // An installed browser on Windows takes longer than the default five seconds to start.
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
    }, 30_000);

    /** A shop at a public address, whose page and redirect point into the office network. */
    async function shop() {
      const context = await browser.newContext();
      await refusePrivateRequests(context, "private-address-refused");
      const page = await context.newPage();
      // Registered on the page, so it is asked before the context's rule, as a real public site
      // would be answered by the internet: only the public host is played here.
      await page.route("http://shop.example.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/go") {
          return route.fulfill({
            status: 302,
            headers: { location: "http://192.168.1.1/admin" },
          });
        }
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>Shop</title>
          <img src="http://10.0.0.5/printer.png">
          <form method="post" action="http://192.168.1.1/password"><button>Go</button></form>`,
        });
      });
      const refused = (url: string) =>
        page.waitForEvent("requestfailed", {
          predicate: (request) =>
            request.url() === url &&
            /BLOCKED_BY_CLIENT|PROXY_CONNECTION_FAILED/.test(
              request.failure()?.errorText ?? "",
            ),
          timeout: 5_000,
        });
      return { context, page, refused };
    }

    test("an image pointed at a printer is refused", async () => {
      const { context, page, refused } = await shop();
      const image = refused("http://10.0.0.5/printer.png");
      await page.goto("http://shop.example.test/");
      await image;
      await context.close();
    });

    test("a form posting to the router is refused", async () => {
      const { context, page, refused } = await shop();
      await page.goto("http://shop.example.test/");
      const form = refused("http://192.168.1.1/password");
      await page.click("button");
      await form;
      await context.close();
    });

    test("a public address that redirects to the router is refused at the redirect", async () => {
      const { context, page, refused } = await shop();
      const redirect = refused("http://192.168.1.1/admin");
      const answer = await page
        .goto("http://shop.example.test/go")
        .catch((error: Error) => error.message);
      await redirect;
      expect(String(answer)).toContain("ERR_PROXY_CONNECTION_FAILED");
      await context.close();
    });

    test("a real public site loads through the proxy script", async () => {
      // Every other case here is played by Playwright's routing and never reaches the network, so it
      // never asks the script anything. This one does: the script resolves the name, finds it public
      // and answers DIRECT. Skipped without a network, as the CI runners have one.
      const online = await fetch("https://example.com/", {
        signal: AbortSignal.timeout(10_000),
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (!online) {
        console.warn(
          "example.com unreachable; real-network case not exercised",
        );
        return;
      }
      const context = await browser.newContext();
      const page = await context.newPage();
      const answer = await page.goto("https://example.com/", {
        timeout: 30_000,
      });
      expect(answer?.status()).toBe(200);
      expect(await page.title()).toContain("Example Domain");
      await context.close();
    }, 60_000);

    test("a public page still loads", async () => {
      const { context, page } = await shop();
      await page.goto("http://shop.example.test/");
      expect(await page.title()).toBe("Shop");
      await context.close();
    });
  },
);
