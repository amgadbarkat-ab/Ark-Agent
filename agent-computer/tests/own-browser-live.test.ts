import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
  freePort,
  type OwnBrowserComputer,
  standInBrowser,
  startOwnBrowserComputer,
} from "./own-browser-stand-in";

/**
 * Driving the person's own browser, against a real Chromium standing in for it.
 *
 * ASKED FOR BY NAME, like the live screen, because it starts a browser and imports Playwright, which
 * CI does not install for this directory:
 *
 *   OPENBOT_OWN_BROWSER=1 bun test tests/own-browser-live.test.ts
 */
const asked = process.env.OPENBOT_OWN_BROWSER === "1";

let computer: OwnBrowserComputer;
let site: ReturnType<typeof Bun.serve>;
let sitePort = 0;
/** Every path the local site was asked for, so a request that should never have left is visible. */
const hits: string[] = [];

const PAGE = `<!doctype html><title>Supplier</title>
<h1>Quote request</h1>
<label>Company <input name="company"></label>
<button onclick="document.title='clicked'">Check stock</button>
<a href="http://127.0.0.1:PORT/router-admin">Router settings</a>
<img alt="pixel" src="http://127.0.0.1:PORT/pixel.gif">`;

async function call(
  botId: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${computer.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-bot-id": botId,
      "x-openbot-computer-token": computer.token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

type Element = { ref: string; name: string };

describe.skipIf(!asked)(
  "the person's own browser, driven by agent-computer",
  () => {
    beforeAll(async () => {
      sitePort = await freePort();
      site = Bun.serve({
        hostname: "127.0.0.1",
        port: sitePort,
        fetch(request) {
          hits.push(new URL(request.url).pathname);
          return new Response(PAGE.replaceAll("PORT", String(sitePort)), {
            headers: { "content-type": "text/html" },
          });
        },
      });
      // Served on a public-looking name, because every private address is refused.
      computer = await startOwnBrowserComputer({
        hostResolverRules: "MAP supplier.example 127.0.0.1",
      });
    }, 60_000);

    afterAll(async () => {
      await computer?.stop();
      site?.stop(true);
    });

    test("it says it is the person's browser and answers on loopback only", async () => {
      const health = await call("ana", "/health");
      expect(health.body.target).toBe("own-browser");

      const outward = Object.values(networkInterfaces())
        .flat()
        .find(
          (address) =>
            address && address.family === "IPv4" && !address.internal,
        );
      if (outward) {
        const port = new URL(computer.baseUrl).port;
        const reached = await fetch(
          `http://${outward.address}:${port}/health`,
          {
            signal: AbortSignal.timeout(2_000),
          },
        ).then(
          () => true,
          () => false,
        );
        expect(reached).toBe(false);
      }
    });

    test("an employee opens a page in its own tab, reads it and acts on it", async () => {
      const opened = await call("ana", "/navigate", {
        url: `http://supplier.example:${sitePort}/`,
      });
      expect(opened.status).toBe(200);
      expect(String(opened.body.text)).toContain("Quote request");

      const snapshot = await call("ana", "/snapshot", {});
      const button = (snapshot.body.elements as Element[]).find(
        (element) => element.name === "Check stock",
      );
      expect(button).toBeDefined();
      const clicked = await call("ana", "/click", {
        ref: button?.ref,
        snapshotId: snapshot.body.snapshotId,
      });
      expect(clicked.status).toBe(200);
      expect((await call("ana", "/read")).body.title).toBe("clicked");
    }, 30_000);

    test("the browser works in the dedicated profile it was given", async () => {
      // Chromium writes its own files into the profile folder it is using. Finding them in the folder
      // the desktop named is the proof the person's main profile was not the one opened.
      const written = await readdir(computer.profileDir);
      expect(written).toContain("Default");
    });

    test("the person's own network is refused, by address and by every request a page makes", async () => {
      for (const url of [
        "http://192.168.1.1/",
        `http://127.0.0.1:${sitePort}/router-admin`,
        "http://printer.local/",
      ]) {
        expect((await call("ana", "/navigate", { url })).status).toBe(403);
      }

      // The page pointed an image at a private address and links to one. Neither left the browser.
      expect(hits).not.toContain("/pixel.gif");
      const snapshot = await call("ana", "/snapshot", {});
      const link = (snapshot.body.elements as Element[]).find(
        (element) => element.name === "Router settings",
      );
      await call("ana", "/click", {
        ref: link?.ref,
        snapshotId: snapshot.body.snapshotId,
      });
      await Bun.sleep(500);
      expect(hits).not.toContain("/router-admin");
    }, 30_000);

    test("no files, no shell and no reset on the person's computer", async () => {
      for (const path of [
        "/exec",
        "/files/read",
        "/files/write",
        "/files/list",
      ]) {
        const refused = await call("ana", path, { command: "id", path: "x" });
        expect(refused.status).toBe(403);
      }
      expect((await call("ana", "/computers/reset", {})).status).toBe(403);
    });

    test("each employee has its own tab, and Stop closes that tab and never the browser", async () => {
      await call("ben", "/navigate", {
        url: `http://supplier.example:${sitePort}/?ben`,
      });
      const running = async () =>
        (
          (await call("ana", "/computers")).body.computers as Array<{
            botId: string;
            running: boolean;
          }>
        )
          .filter((computer) => computer.running)
          .map((computer) => computer.botId);
      expect(await running()).toEqual(["ana", "ben"]);

      const stopped = await call("ben", "/computers/stop", {});
      expect(stopped.body.wasRunning).toBe(true);
      expect(await running()).toEqual(["ana"]);
      // The browser is still there, and so is the other employee's tab (on the error page its blocked
      // router link left it on).
      const other = await call("ana", "/read");
      expect(other.status).toBe(200);
      expect(String(other.body.url)).toStartWith("chrome-error://");
    }, 30_000);
  },
);

describe.skipIf(!asked)("whose tab is whose, in-process", () => {
  test("a tab the person opens is not the employee's, and closing the browser is the switch going off", async () => {
    const { chromium } = await import("playwright");
    const { createOwnBrowserProfiles } = await import(
      "../src/own-browser-profiles"
    );
    const executable = standInBrowser();
    expect(executable).not.toBeNull();
    const scratch = await mkdtemp(join(tmpdir(), "arkagent-own-tabs-"));
    let gone = 0;
    let context: Awaited<
      ReturnType<typeof chromium.launchPersistentContext>
    > | null = null;
    const profiles = createOwnBrowserProfiles(
      {
        executable: executable ?? "",
        profileDir: join(scratch, "profile"),
        headless: true,
      },
      () => {},
      () => {
        gone += 1;
      },
      async (settings) => {
        context = await chromium.launchPersistentContext(settings.profileDir, {
          executablePath: settings.executable,
          headless: true,
          args: ["--no-sandbox"],
        });
        return context;
      },
    );
    try {
      const employees = await profiles.page("ana");
      // The person opens a tab of their own in the same window.
      const persons = await context!.newPage();
      expect(await profiles.page("ana")).toBe(employees);
      expect(persons).not.toBe(employees);

      // A window the employee's own page opens is followed.
      const [popup] = await Promise.all([
        employees.waitForEvent("popup"),
        employees.evaluate(() => window.open("about:blank#signin")),
      ]);
      expect(await profiles.page("ana")).toBe(popup);

      await context!.close();
      await Bun.sleep(200);
      expect(gone).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
