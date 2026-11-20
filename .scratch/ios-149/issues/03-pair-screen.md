# Pair screen on the iPhone

Status: resolved

Blocked by: `shared/ark-link.ts` (claude/android-149, read at 05b0371)

## Answer

The iPhone's pair screen is the relay's own page, `/_link/pair` (Greek and English, built by sub-agent B),
not a page bundled in the app. The app opens the Ark Link host; an unpaired phone is sent to the pair
page there.

Why not a page inside the app (`www/`):

- The device token has to end up as the relay's `ark_link` cookie, because a web view cannot add an
  `Authorization` header to every request, script, image and WebSocket a page makes. A page inside the
  app runs at `capacitor://localhost`, so a cookie the relay set in answer to it would be a third-party
  cookie, which WebKit's tracking prevention blocks in an app's web view. The pair page has to be on the
  relay's own origin for the cookie to be first-party.
- One pair page for Android (Chrome) and iOS, so the two cannot drift: the same reasoning as the
  decision record's "one web app".

The app's own page (`www/index.html`) is only the "cannot be reached" page, in Greek and English.

QR: Capacitor's core has no camera or barcode API (its iOS plugins are Cookies, Http, Console,
SystemBars and WebView), so the code is typed. Scanning the desktop's QR with the iPhone's Camera opens
Safari, not the app, and pairs Safari: only universal links (an Associated Domains entitlement, which
needs the Apple developer account) would open the app instead.

## Comments
