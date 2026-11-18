# Sign-in inside the shell, and the system-browser hand-off

Status: resolved

## Answer

The system-browser hand-off (`server/src/auth/native-browser.ts`, `app/src/lib/native/`) is **not needed
for Ark Link**, and the Ark Link build does not register a return scheme. The code stays as it is.

- The hand-off exists for one reason: Google refuses to sign anybody in inside an embedded web view, and
  a hosted deployment signs in with Google or Microsoft.
- A desktop install runs with no sign-in at all (`OPENBOT_SINGLE_USER=true`, set by
  `desktop/src-tauri/src/env.rs`). Through the relay the phone gets the desktop's app as its one
  administrator, with nothing to sign in to, so nothing is handed off.
- A desktop with an organization authority (`organizationAuthUrl`) returns to the desktop by loopback
  (`http://127.0.0.1:<port>/organization-auth/callback`), which a phone cannot reach whatever the shell
  does. That is a relay-side question, not an iOS one; Android has it too.
- With no `ARK_IOS_URL_SCHEME` on the desktop's server, `/api/auth/native` is a 404 and
  `useNativeSignInReturn` never starts, so the dormant code costs nothing. If a desktop is ever given an
  identity provider that refuses web views, the hand-off would have to come back through the relay's
  origin, and the scheme would be set again.

What the shell still does for the web app: it appends `ArkStoreApp/ios` to the user agent, so the
desktop's pages show nothing to buy inside the App Store app.

Open (for PE/Amgad, also raised by B): pairing is the only gate on a single-user desktop. Answered
18 Nov: sign-in is required (below).

## Comments

**18 Nov, after Amgad's decision (06:40): the desktop install requires sign-in before pairing (option b,
built by B).** The person signs in with their ArkAgent account after pairing, on the desktop's own
sign-in page, inside the app. What that means for the shell depends on how that account signs in:

- **A password (or a code) the desktop checks itself:** works inside the web view as it is. Nothing to
  build in the shell; the hand-off stays unused.
- **Google:** Google refuses an embedded web view, so the hand-off would be needed again, and it would
  have to come back through the relay's origin: the system browser signs in at
  `https://<link host>/api/auth/native` (a relay-served path to the desktop's page, with the desktop
  given `ARK_IOS_URL_SCHEME`), and the app is reopened by its scheme. The shell then needs
  `ARK_IOS_URL_SCHEME` set at build time (already supported) and `allowNavigation` unchanged. Microsoft
  works in a web view but is cleaner the same way.

Question for B/PE: which is it? The answer decides whether the next shell build registers a scheme.
