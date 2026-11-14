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
/** Kept across versions: the language the page chose, for notifications and the offline page. */
const SETTINGS = "ark-settings";
const SHELL = [
  "/offline.html",
  "/offline-el.html",
  "/offline.css",
  "/icons/icon-192.png",
];

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
            .filter((name) => name !== VERSION && name !== SETTINGS)
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
      fetch(request).catch(async () => {
        const page =
          (await chosenLanguage()) === "el"
            ? "/offline-el.html"
            : "/offline.html";
        return (await caches.match(page)) || Response.error();
      }),
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

/**
 * The notifications the server sends, in Greek. The page writes the language it was set to into
 * Cache Storage (src/lib/i18n.ts, `shareLanguage`), since a worker cannot read `localStorage`.
 * Keep in step with server/src/routines/runner.ts and server/src/push/routes.ts.
 */
const NOTIFICATIONS_EL = {
  "Notifications are on": "Οι ειδοποιήσεις είναι ενεργές",
  "This is how Ark will tell you when your digital employees finish something.":
    "Έτσι θα σας ενημερώνει το Ark όταν οι ψηφιακοί σας υπάλληλοι ολοκληρώνουν κάτι.",
  "A routine failed": "Μια ρουτίνα απέτυχε",
  "Open Ark to see what went wrong.":
    "Ανοίξτε το Ark για να δείτε τι πήγε στραβά.",
  "A routine was switched off": "Μια ρουτίνα απενεργοποιήθηκε",
  "It failed ten times in a row. Open Ark to see why.":
    "Απέτυχε δέκα φορές στη σειρά. Ανοίξτε το Ark για να δείτε γιατί.",
  "A routine finished": "Μια ρουτίνα ολοκληρώθηκε",
  "Open Ark to see what it did.": "Ανοίξτε το Ark για να δείτε τι έκανε.",
};

async function chosenLanguage() {
  try {
    const cache = await caches.open(SETTINGS);
    const stored = await cache.match("/__ark/language");
    return stored && (await stored.text()) === "el" ? "el" : "en";
  } catch {
    return "en";
  }
}

async function showPush(message) {
  const greek = (await chosenLanguage()) === "el";
  const say = (text) => (greek && NOTIFICATIONS_EL[text]) || text;
  const title =
    typeof message.title === "string" && message.title
      ? say(message.title)
      : "ArkAgent";
  const options = {
    body: typeof message.body === "string" ? say(message.body) : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof message.tag === "string" ? message.tag : undefined,
    data: { url: placeIn(message.url) },
  };
  await self.registration.showNotification(title, options);
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  event.waitUntil(showPush(message));
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
