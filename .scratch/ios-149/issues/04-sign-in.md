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

Open (for PE/Amgad, also raised by B): pairing is the only gate on a single-user desktop.

## Comments
