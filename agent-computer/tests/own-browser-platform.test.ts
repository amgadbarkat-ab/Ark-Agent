import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  type OwnBrowserComputer,
  standInBrowser,
  startOwnBrowserComputer,
} from "./own-browser-stand-in";

/**
 * Device control on a real Chrome or Edge, as a customer has it (desk #85, steps 6–11).
 *
 * The other own-browser tests stand Playwright's Chromium in for the person's browser on Linux. This
 * one is for Windows and macOS, where the browser is the installed Chrome or Edge with its own sandbox,
 * started the way the desktop starts it: `agent-computer` launches it directly over a pipe, with the
 * dedicated ArkAgent profile. The CI job names the browser in OWN_BROWSER_STAND_IN.
 *
 * Only public addresses are visited, so no local site and no name mapping are needed: the desktop's
 * own path, unchanged, is what runs.
 */
const asked = process.env.OPENBOT_OWN_BROWSER_PLATFORM === "1";
const executable = asked ? standInBrowser() : null;

let computer: OwnBrowserComputer;

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
  const answer = {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
  // A failure here is on somebody else's machine, so what agent-computer said is the only clue.
  if (answer.status >= 500) {
    console.error(`${path} -> ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer;
}

describe.skipIf(!executable)(
  "the person's own installed browser, driven as the desktop drives it",
  () => {
    beforeAll(async () => {
      computer = await startOwnBrowserComputer({ direct: true });
    }, 90_000);

    afterAll(async () => {
      await computer?.stop();
    }, 30_000);

    test("it says it is the person's browser", async () => {
      const health = await call("ana", "/health");
      expect(health.status).toBe(200);
      expect(health.body.target).toBe("own-browser");
    });

    test("an employee opens a public page in its own tab and reads it", async () => {
      const opened = await call("ana", "/navigate", {
        url: "https://example.com/",
      });
      expect(opened.status).toBe(200);
      const read = await call("ana", "/read");
      expect(read.status).toBe(200);
      expect(String(read.body.title)).toContain("Example Domain");
    }, 60_000);

    test("the browser works in the dedicated profile, not the person's own", async () => {
      expect(await readdir(computer.profileDir)).toContain("Default");
    });

    test("a private address is refused when asked for", async () => {
      for (const url of ["http://192.168.1.1/", "http://10.0.0.1/"]) {
        expect((await call("ana", "/navigate", { url })).status).toBe(403);
      }
    }, 30_000);

    test("a public address that redirects to the router does not reach it", async () => {
      // The case only the browser's proxy script catches (private-network.ts): the address asked for
      // is public, and the hop after it is not. A public redirect service plays the public page; when
      // it cannot be reached from this machine there is nothing to learn, and the test says so.
      const service =
        "https://httpbin.org/redirect-to?url=http%3A%2F%2F192.168.1.1%2F";
      const reachable = await fetch("https://httpbin.org/status/200", {
        signal: AbortSignal.timeout(10_000),
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (!reachable) {
        console.warn("httpbin.org unreachable; redirect case not exercised");
        return;
      }
      await call("ana", "/navigate", { url: service });
      const read = await call("ana", "/read");
      // Either the browser stayed on its error page or never left the redirect; never the router.
      expect(String(read.body.url)).not.toStartWith("http://192.168.1.1");
    }, 60_000);

    test("each employee has its own tab, and Stop closes that tab and not the browser", async () => {
      expect(
        (await call("ben", "/navigate", { url: "https://example.org/" }))
          .status,
      ).toBe(200);
      const running = async () =>
        (
          (await call("ana", "/computers")).body.computers as Array<{
            botId: string;
            running: boolean;
          }>
        )
          .filter((entry) => entry.running)
          .map((entry) => entry.botId)
          .sort();
      expect(await running()).toEqual(["ana", "ben"]);
      expect((await call("ben", "/computers/stop", {})).status).toBe(200);
      expect(await running()).toEqual(["ana"]);
      expect((await call("ana", "/read")).status).toBe(200);
    }, 60_000);

    test("no files, no shell and no reset on the person's computer", async () => {
      for (const path of ["/exec", "/files/read", "/files/write"]) {
        const refused = await call("ana", path, {
          command: "whoami",
          path: "x",
        });
        expect(refused.status).toBe(403);
      }
      expect((await call("ana", "/computers/reset", {})).status).toBe(403);
    });
  },
);
