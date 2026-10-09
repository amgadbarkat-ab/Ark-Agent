import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The installable app's service worker, run against stand-ins for what a browser gives it.
 *
 * What is protected: nothing from `/api` is ever kept (those answers are one person's conversations
 * and account, and the next person to hold the same phone must never be handed them); a page that
 * cannot be reached shows the offline page; a notification opens a place in this app and nowhere
 * else.
 */

const publicDir = join(import.meta.dir, "..", "public");
const source = readFileSync(join(publicDir, "sw.js"), "utf8");
const ORIGIN = "https://ark.example";

type Handler = (event: Record<string, unknown>) => void;

function loadWorker(
  options: {
    network?: (url: string) => Promise<Response>;
    windows?: {
      url: string;
      navigate: (to: string) => Promise<unknown>;
      focus: () => Promise<unknown>;
    }[];
  } = {},
) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, Response>>();
  const requested: string[] = [];
  const opened: string[] = [];
  const shown: { title: string; options: Record<string, unknown> }[] = [];

  const keyOf = (request: unknown) =>
    typeof request === "string" ? request : (request as { url: string }).url;
  const normal = (key: string) =>
    key.startsWith("http") ? key : `${ORIGIN}${key}`;
  const cacheNamed = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name) as Map<string, Response>;
    return {
      addAll: async (urls: string[]) => {
        for (const url of urls)
          entries.set(normal(url), new Response(`cached ${url}`));
      },
      put: async (request: unknown, response: Response) => {
        entries.set(normal(keyOf(request)), response);
      },
      match: async (request: unknown) =>
        entries.get(normal(keyOf(request)))?.clone(),
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (request: unknown) =>
        entries.delete(normal(keyOf(request))),
    };
  };
  const caches = {
    open: async (name: string) => cacheNamed(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: unknown) => {
      for (const name of stores.keys()) {
        const hit = await cacheNamed(name).match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const fetchFn = async (request: unknown) => {
    const url = keyOf(request);
    requested.push(url);
    return options.network
      ? options.network(url)
      : new Response(`network ${url}`);
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => options.windows ?? [],
      openWindow: async (to: string) => {
        opened.push(to);
      },
    },
    registration: {
      showNotification: async (
        title: string,
        shownOptions: Record<string, unknown>,
      ) => {
        shown.push({ title, options: shownOptions });
      },
    },
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetchFn);

  const pending: Promise<unknown>[] = [];
  const dispatch = (type: string, event: Record<string, unknown>) => {
    let responded: Promise<Response> | undefined;
    handlers[type]?.({
      ...event,
      respondWith: (answer: Promise<Response>) => {
        responded = answer;
      },
      waitUntil: (work: Promise<unknown>) => {
        pending.push(work);
      },
    });
    return { responded, settled: () => Promise.all(pending) };
  };
  const fetchEvent = (url: string, extra: Record<string, unknown> = {}) =>
    dispatch("fetch", {
      request: {
        method: "GET",
        url: `${ORIGIN}${url}`,
        mode: "no-cors",
        ...extra,
      },
    });
  return { handlers, stores, requested, opened, shown, dispatch, fetchEvent };
}

describe("what it will not touch", () => {
  test("nothing under /api is answered by the worker, so nothing from it can be kept", async () => {
    const worker = loadWorker();
    for (const path of [
      "/api/me",
      "/api/agents",
      "/api/channels/x/messages?limit=5",
      "/api",
    ]) {
      const { responded } = worker.fetchEvent(path);
      expect(responded).toBeUndefined();
    }
    // A sign-in or a download is a navigation to the API, and it is not the worker's to answer or to
    // replace with an offline page.
    for (const path of ["/api/auth/callback/google", "/api/account/export"]) {
      expect(
        worker.fetchEvent(path, { mode: "navigate" }).responded,
      ).toBeUndefined();
    }
    expect(worker.requested).toEqual([]);
    expect([...worker.stores.keys()]).toEqual([]);
  });

  test("anything but a plain GET to this origin goes straight through", () => {
    const worker = loadWorker();
    expect(
      worker.fetchEvent("/assets/a.js", { method: "POST" }).responded,
    ).toBeUndefined();
    const foreign = worker.dispatch("fetch", {
      request: {
        method: "GET",
        url: "https://elsewhere.example/assets/a.js",
        mode: "no-cors",
      },
    });
    expect(foreign.responded).toBeUndefined();
    expect(worker.requested).toEqual([]);
  });

  test("an API answer is never stored even if it comes back through a navigation", async () => {
    const worker = loadWorker({
      network: async () => new Response("secret conversation"),
    });
    const { responded } = worker.fetchEvent("/api/channels/x/messages");
    expect(responded).toBeUndefined();
    for (const store of worker.stores.values()) {
      for (const [key, value] of store.entries()) {
        expect(key).not.toContain("/api");
        expect(await value.clone().text()).not.toContain("secret");
      }
    }
  });
});

describe("pages and built files", () => {
  test("installing keeps the offline page, and activating drops the caches of older versions", async () => {
    const worker = loadWorker();
    worker.stores.set("ark-shell-v0", new Map([["x", new Response("old")]]));
    const install = worker.dispatch("install", {});
    await install.settled();
    const activate = worker.dispatch("activate", {});
    await activate.settled();
    expect([...worker.stores.keys()]).toEqual(["ark-shell-v1"]);
    expect(
      await worker.stores
        .get("ark-shell-v1")
        ?.get(`${ORIGIN}/offline.html`)
        ?.text(),
    ).toContain("offline");
  });

  test("a page that can be reached comes from the network, and one that cannot shows the offline page", async () => {
    let online = true;
    const worker = loadWorker({
      network: async (url) => {
        if (!online) throw new TypeError("offline");
        return new Response(`page ${url}`);
      },
    });
    await worker.dispatch("install", {}).settled();
    const reachable = worker.fetchEvent("/routines", { mode: "navigate" });
    expect(await (await reachable.responded)?.text()).toContain("page ");
    online = false;
    const unreachable = worker.fetchEvent("/routines", { mode: "navigate" });
    expect(await (await unreachable.responded)?.text()).toContain("offline");
  });

  test("a built file is fetched once and then comes from the copy", async () => {
    const worker = loadWorker();
    const first = worker.fetchEvent("/assets/index-abc123.js");
    expect(await (await first.responded)?.text()).toContain("network");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = worker.fetchEvent("/assets/index-abc123.js");
    expect(await (await second.responded)?.text()).toContain("network");
    expect(worker.requested).toEqual([`${ORIGIN}/assets/index-abc123.js`]);
  });

  test("a failed answer is not kept, and other files are left to the browser", async () => {
    const worker = loadWorker({
      network: async () => new Response("no", { status: 500 }),
    });
    const bad = worker.fetchEvent("/assets/broken.js");
    await bad.responded;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const again = worker.fetchEvent("/assets/broken.js");
    await again.responded;
    expect(worker.requested).toHaveLength(2);
    expect(worker.fetchEvent("/favicon.ico").responded).toBeUndefined();
  });

  test("the copies of built files are bounded, oldest first", async () => {
    const worker = loadWorker();
    for (let n = 0; n < 230; n++) {
      const event = worker.fetchEvent(`/assets/file-${n}.js`);
      await event.responded;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const kept = worker.stores.get("ark-shell-v1") as Map<string, Response>;
    expect(kept.size).toBeLessThanOrEqual(200);
    expect(kept.has(`${ORIGIN}/assets/file-229.js`)).toBe(true);
    expect(kept.has(`${ORIGIN}/assets/file-0.js`)).toBe(false);
  });
});

describe("notifications", () => {
  const push = (worker: ReturnType<typeof loadWorker>, payload: unknown) =>
    worker.dispatch("push", {
      data: {
        json: () =>
          typeof payload === "string" ? JSON.parse(payload) : payload,
      },
    });

  test("shows what the server sent, and remembers where it leads", async () => {
    const worker = loadWorker();
    await push(worker, {
      title: "Weekly report ready",
      body: "Your finance assistant finished.",
      url: "/routines",
      tag: "routine-1",
    }).settled();
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.title).toBe("Weekly report ready");
    expect(worker.shown[0]?.options).toMatchObject({
      body: "Your finance assistant finished.",
      tag: "routine-1",
      data: { url: "/routines" },
    });
  });

  test("a message that cannot be read still shows something, and never a foreign address", async () => {
    const worker = loadWorker();
    await push(worker, "{not json").settled();
    expect(worker.shown[0]?.title).toBe("Ark");
    const other = loadWorker();
    await push(other, {
      title: "x",
      url: "https://evil.example/phish",
    }).settled();
    expect(other.shown[0]?.options).toMatchObject({ data: { url: "/" } });
    const same = loadWorker();
    await push(same, {
      title: "x",
      url: `${ORIGIN}/channel/abc?x=1#top`,
    }).settled();
    expect(same.shown[0]?.options).toMatchObject({
      data: { url: "/channel/abc?x=1#top" },
    });
  });

  test("tapping one brings an open window to the place, or opens one", async () => {
    const navigated: string[] = [];
    const focused: string[] = [];
    const open = loadWorker({
      windows: [
        {
          url: `${ORIGIN}/`,
          navigate: async (to) => {
            navigated.push(to);
            return { focus: async () => focused.push(to) };
          },
          focus: async () => focused.push("same"),
        },
      ],
    });
    const closed: boolean[] = [];
    await open
      .dispatch("notificationclick", {
        notification: {
          close: () => closed.push(true),
          data: { url: "/routines" },
        },
      })
      .settled();
    expect(closed).toEqual([true]);
    expect(navigated).toEqual(["/routines"]);
    expect(focused).toEqual(["/routines"]);

    const none = loadWorker();
    await none
      .dispatch("notificationclick", {
        notification: { close: () => undefined, data: { url: "/skills" } },
      })
      .settled();
    expect(none.opened).toEqual(["/skills"]);

    const tampered = loadWorker();
    await tampered
      .dispatch("notificationclick", {
        notification: {
          close: () => undefined,
          data: { url: "https://evil.example/x" },
        },
      })
      .settled();
    expect(tampered.opened).toEqual(["/"]);
  });
});

describe("what makes it installable", () => {
  const manifest = JSON.parse(
    readFileSync(join(publicDir, "manifest.webmanifest"), "utf8"),
  );
  const dimensions = (file: string) => {
    const bytes = readFileSync(join(publicDir, file));
    // PNG: an 8-byte signature, then the header chunk with the width and height as big-endian words.
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };

  test("names the app, starts inside its scope and opens as an app", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.scope).toBe("/");
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.url.startsWith("/")).toBe(true);
    }
  });

  test("has real icons at the sizes it says, including one a launcher may crop", () => {
    const icons = manifest.icons as {
      src: string;
      sizes: string;
      purpose: string;
    }[];
    for (const icon of icons) {
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(dimensions(icon.src.slice(1))).toEqual([width, height]);
    }
    expect(
      icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any"),
    ).toBe(true);
    expect(
      icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any"),
    ).toBe(true);
    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    expect(dimensions("icons/apple-touch-icon.png")).toEqual([180, 180]);
  });

  test("the page points at the manifest and the offline page needs nothing but its stylesheet", () => {
    const html = readFileSync(join(publicDir, "..", "index.html"), "utf8");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
    const offline = readFileSync(join(publicDir, "offline.html"), "utf8");
    expect(offline).not.toContain("<script");
    expect(offline).not.toMatch(/style=/);
    expect(offline).toContain('href="/offline.css"');
  });
});
