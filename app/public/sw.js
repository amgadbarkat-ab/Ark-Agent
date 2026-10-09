/*
 * The app's service worker. It does three things and refuses to do a fourth.
 *
 *  1. Keeps the app's own scripts and styles, so a phone opens the app quickly on a bad connection.
 *  2. Shows a plain offline page when a page cannot be reached at all.
 *  3. Shows a notification when the server sends one, and opens the right place when it is tapped.
 *
 * IT NEVER KEEPS ANYTHING FROM `/api`. Those answers are one person's conversations, files and
 * account, and a worker that cached them would hand them to the next person to pick up the same
 * device. Everything under `/api`, and every request that is not a plain GET to this origin, goes
 * to the network untouched, so a signed-out phone shows nothing of whoever used it before.
 */
const VERSION = "ark-shell-v1";
const SHELL = ["/offline.html", "/offline.css", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== VERSION)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** The most built files kept. Each release adds new names, so without a limit the oldest never leave. */
const MOST_KEPT = 200;

function trim(cache) {
  return cache
    .keys()
    .then((keys) =>
      Promise.all(
        keys
          .slice(0, Math.max(0, keys.length - MOST_KEPT))
          .map((key) => cache.delete(key)),
      ),
    );
}

/** Whether this worker may keep a copy of the response to a request. */
function keepable(url) {
  // Built files carry a hash of their contents in their names, so a stale copy cannot exist.
  return (
    url.origin === self.location.origin && url.pathname.startsWith("/assets/")
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/offline.html").then((page) => page || Response.error()),
      ),
    );
    return;
  }

  if (keepable(url)) {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        cache.match(request).then(
          (hit) =>
            hit ||
            fetch(request).then((response) => {
              if (response.ok)
                cache.put(request, response.clone()).then(() => trim(cache));
              return response;
            }),
        ),
      ),
    );
  }
});

/** A notification's address, reduced to a place in this app. Anything else is the home screen. */
function placeIn(address) {
  try {
    const url = new URL(address, self.location.origin);
    if (url.origin === self.location.origin)
      return url.pathname + url.search + url.hash;
  } catch {
    // Fall through.
  }
  return "/";
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const title =
    typeof message.title === "string" && message.title ? message.title : "Ark";
  const options = {
    body: typeof message.body === "string" ? message.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof message.tag === "string" ? message.tag : undefined,
    data: { url: placeIn(message.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const place = placeIn(event.notification.data?.url);
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const window of windows) {
          if (
            new URL(window.url).origin === self.location.origin &&
            "focus" in window
          ) {
            return window
              .navigate(place)
              .then((navigated) => (navigated || window).focus());
          }
        }
        return self.clients.openWindow(place);
      }),
  );
});
