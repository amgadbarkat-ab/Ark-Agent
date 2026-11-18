/**
 * PROPOSED for `server/tests/ark-link-ios-shell.test.ts` once `infra/ark-link/` and
 * `server/src/ark-link/` (claude/android-149) are on the same branch as this. Kept here under a name
 * `bun test` does not pick up, because on claude/ios-149 alone its imports do not exist. It passed,
 * 8 of 8, against claude/android-149 at f2dc5ef.
 *
 * The iOS app through Ark Link (#149), as far as it can be walked without a Mac.
 *
 * The iOS app is a web view (WKWebView, through Capacitor) whose start address is the Ark Link host.
 * It cannot put a header on the requests a page makes, so it carries the device token the way Chrome
 * does: the relay's `ark_link` cookie. This walks what that web view sends and keeps, against the
 * real relay and this install's real connector in front of a stand-in desktop app:
 *
 *  - a navigation to `/` with no cookie is sent to the pair page, which is the relay's own;
 *  - the pairing page's two requests, then the cookie the relay sets, with the attributes the web
 *    view needs to keep it for a long time and send it on every same-origin request and socket;
 *  - the desktop's app, reached with the cookie alone, told by the user agent that it is inside the
 *    App Store app (so it shows nothing to buy), and never given the device token;
 *  - the offline and not-paired pages, which are what the app shows when the relay answers, as
 *    opposed to its own page, which it shows only when the relay cannot be reached at all.
 *
 * What it cannot show: WebKit itself (cookie store, tracking prevention), which only a real iPhone or
 * the simulator against a running relay can.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createLinkRelay } from "../../infra/ark-link/relay";
import { USER_AGENT_TOKEN } from "../../mobile/scripts/ios-config";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  newDeviceToken,
  newInstallToken,
  tokenHash,
} from "../../shared/ark-link";
import {
  type ArkLinkEvent,
  createArkLinkConnector,
} from "../src/ark-link/connector";

const LINK_ORIGIN = "https://link.example";
const installToken = newInstallToken();
const installHash = await tokenHash(installToken);
const relay = createLinkRelay({
  linkOrigin: LINK_ORIGIN,
  installs: () => [{ id: "ios-shop", tokenSha256: installHash }],
  log: () => undefined,
});
const relayServer = Bun.serve({
  port: 0,
  fetch: relay.fetch,
  websocket: relay.websocket,
});
const relayBase = `http://localhost:${relayServer.port}`;

/** The desktop's app, as far as the phone can tell. */
const seen: Request[] = [];
const app = Bun.serve<undefined>({
  port: 0,
  fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket")
      return server.upgrade(request, { data: undefined })
        ? undefined
        : new Response("no", { status: 400 });
    seen.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === "/api/me") return Response.json({ ok: true });
    return new Response(`<html>the desktop's app at ${url.pathname}</html>`, {
      headers: { "content-type": "text/html" },
    });
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo ${message}`);
    },
  },
});

const paired = new Map<string, string>();
const events: ArkLinkEvent[] = [];
const connector = createArkLinkConnector({
  relayUrl: relayBase,
  installToken,
  localOrigin: `http://127.0.0.1:${app.port}`,
  allowInsecureRelay: true,
  devices: {
    verify: async (id, hash) => paired.get(id) === hash,
    list: async () =>
      [...paired].map(([id, tokenSha256]) => ({ id, tokenSha256 })),
    used: () => undefined,
  },
  onEvent: (event) => events.push(event),
});

afterAll(() => {
  connector.stop();
  relay.stop();
  void relayServer.stop(true);
  void app.stop(true);
});

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await Bun.sleep(10);
  expect(check()).toBe(true);
};

/** What WKWebView on an iPhone sends as its user agent, with the token Capacitor appends. */
const IOS_USER_AGENT = `Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${USER_AGENT_TOKEN}`;

/**
 * The iOS app's web view, reduced to what matters here: one origin, a cookie jar fed by `Set-Cookie`,
 * the app's user agent, and navigations marked as navigations (`Sec-Fetch-Mode: navigate`), as
 * WebKit marks them. It never sends an `Authorization` header: a page cannot make it.
 */
class WebView {
  jar = new Map<string, { value: string; attributes: string[] }>();

  private cookieHeader(): Record<string, string> {
    if (this.jar.size === 0) return {};
    return {
      cookie: [...this.jar].map(([name, c]) => `${name}=${c.value}`).join("; "),
    };
  }

  private keep(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const at = (pair as string).indexOf("=");
      const name = (pair as string).slice(0, at);
      const value = (pair as string).slice(at + 1);
      if (attributes.some((a) => /^max-age=0$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, { value, attributes });
    }
  }

  /** A top-level load: what the app does at launch, on a link, and on `location.replace`. */
  async navigate(path: string): Promise<{ response: Response; path: string }> {
    let current = path;
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetch(`${relayBase}${current}`, {
        redirect: "manual",
        headers: {
          "user-agent": IOS_USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          ...this.cookieHeader(),
        },
      });
      this.keep(response);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, `${relayBase}${current}`).pathname;
        continue;
      }
      return { response, path: current };
    }
    throw new Error("too many redirects");
  }

  /** A page's own `fetch`, same origin, as the pairing script and the app make them. */
  async fetch(path: string, init: { method?: string; body?: unknown } = {}) {
    const response = await fetch(`${relayBase}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "user-agent": IOS_USER_AGENT,
        "sec-fetch-mode": "cors",
        origin: relayBase,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...this.cookieHeader(),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    this.keep(response);
    return response;
  }
}

/** The pairing page's script, step by step, with a person at the desktop who says yes. */
async function pairThroughThePage(view: WebView, deviceName: string) {
  const { code } = await connector.startPairing();
  const claim = await (
    await view.fetch("/_link/pair/claim", {
      method: "POST",
      body: { code, deviceName },
    })
  ).json();
  expect(claim.status).toBe("pending");
  await until(() =>
    events.some((e) => e.type === "claimed" && e.pairingId === claim.pairingId),
  );
  const token = newDeviceToken();
  const id = `ios-${paired.size + 1}`;
  const hash = await tokenHash(token);
  paired.set(id, hash);
  connector.confirm(
    claim.pairingId,
    { id, name: deviceName, tokenSha256: hash },
    token,
  );
  await connector.syncDevices();
  let answer: { status: string } = { status: "pending" };
  for (let i = 0; i < 100 && answer.status === "pending"; i++) {
    await Bun.sleep(10);
    answer = await (
      await view.fetch("/_link/pair/status", {
        method: "POST",
        body: { pairingId: claim.pairingId },
      })
    ).json();
  }
  expect(answer.status).toBe("confirmed");
  return { id, token };
}

describe("the iOS app through Ark Link", () => {
  test("the desktop connects out first", async () => {
    connector.start();
    await until(() => connector.status === "connected");
  });

  test("an unpaired app opening the host lands on the relay's own pair page, in Greek and English", async () => {
    const view = new WebView();
    const { response, path } = await view.navigate("/");
    expect(path).toBe("/_link/pair");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('lang="el"');
    expect(page).toContain("Connect to your computer");
    expect(page).toContain('<script src="/_link/pair.js"></script>');
    // The page's script names an iPhone as one, from the app's user agent.
    const script = await (await view.fetch("/_link/pair.js")).text();
    expect(script).toContain('/iPhone/.test(ua) ? "iPhone"');
    expect(IOS_USER_AGENT).toMatch(/iPhone/);
    // Nothing reached the desktop, and no cookie was set.
    expect(seen).toHaveLength(0);
    expect(view.jar.size).toBe(0);
  });

  test("pairing leaves one cookie the web view keeps for 400 days and sends on every request", async () => {
    const view = new WebView();
    await view.navigate("/");
    const phone = await pairThroughThePage(view, "iPhone");
    const cookie = view.jar.get(DEVICE_COOKIE);
    expect(cookie?.value).toBe(phone.token);
    const attributes = (cookie?.attributes ?? []).map((a) => a.toLowerCase());
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("secure");
    expect(attributes).toContain("path=/");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain(`max-age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`);
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 3600);
  });

  test("then the app is the desktop's own, told it is the App Store app, and never given the token", async () => {
    const view = new WebView();
    const phone = await pairThroughThePage(view, "iPhone of Ana");
    seen.length = 0;
    // What the pairing page does when the desktop confirms: location.replace("/").
    const { response, path } = await view.navigate("/");
    expect(path).toBe("/");
    expect(await response.text()).toBe("<html>the desktop's app at /</html>");
    const request = seen.at(-1) as Request;
    expect(request.headers.get("user-agent")).toContain(USER_AGENT_TOKEN);
    expect(request.headers.get("cookie") ?? "").not.toContain(phone.token);
    expect(request.headers.get("authorization")).toBeNull();
    // A navigation renews the cookie, so a phone in use never reaches the 400 days.
    expect(
      response.headers
        .getSetCookie()
        .some((line) => line.startsWith(`${DEVICE_COOKIE}=${phone.token};`)),
    ).toBe(true);
    // The app's own requests carry the cookie alone.
    const me = await view.fetch("/api/me");
    expect(await me.json()).toEqual({ ok: true });
    expect((seen.at(-1) as Request).headers.get("user-agent")).toContain(
      USER_AGENT_TOKEN,
    );
  });

  test("a socket the app opens carries the cookie, as WebKit sends it on the upgrade", async () => {
    const view = new WebView();
    const phone = await pairThroughThePage(view, "Socket iPhone");
    const socket = new WebSocket(
      `ws://localhost:${relayServer.port}/api/channels/socket`,
      {
        headers: {
          cookie: `${DEVICE_COOKIE}=${phone.token}`,
          "user-agent": IOS_USER_AGENT,
          origin: relayBase,
        },
      } as never,
    );
    const heard: string[] = [];
    socket.onmessage = (event) => heard.push(String(event.data));
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    socket.send("γεια");
    await until(() => heard.includes("echo γεια"));
    socket.close();
  });

  test("a request that is not a page load, with no cookie, gets a refusal a script can read, not a page", async () => {
    const view = new WebView();
    const response = await view.fetch("/api/me");
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("ark_link_not_paired");
  });

  test("when the desktop is off the app shows the relay's offline page, which offers to try again", async () => {
    const view = new WebView();
    await pairThroughThePage(view, "Waiting iPhone");
    connector.stop();
    await until(() => relay.connected.length === 0);
    const { response, path } = await view.navigate("/");
    expect(path).toBe("/");
    expect(response.status).toBe(503);
    const page = await response.text();
    expect(page).toContain("Your computer is not connected");
    expect(page).toContain('<a href="/">');
    // The cookie is kept: the phone is still paired, and works again when the desktop is back.
    expect(view.jar.has(DEVICE_COOKIE)).toBe(true);
    connector.start();
    await until(() => connector.status === "connected");
    expect(await (await view.navigate("/")).response.text()).toBe(
      "<html>the desktop's app at /</html>",
    );
  });

  test("a phone removed on the desktop is told so, loses the cookie, and is offered pairing again", async () => {
    const view = new WebView();
    const phone = await pairThroughThePage(view, "Lost iPhone");
    paired.delete(phone.id);
    await connector.syncDevices();
    await until(() => !relay.routed.some((r) => r.id === phone.id));
    const { response } = await view.navigate("/");
    expect(response.status).toBe(401);
    const page = await response.text();
    expect(page).toContain("This phone is not paired");
    expect(page).toContain('<a href="/_link/pair">');
    expect(view.jar.has(DEVICE_COOKIE)).toBe(false);
  });
});
