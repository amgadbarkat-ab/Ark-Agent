# Sign-in inside the shell, and the system-browser hand-off

Status: resolved

## Answer

The system-browser hand-off (`server/src/auth/native-browser.ts`, `app/src/lib/native/`) is **not needed
for Ark Link**, and the Ark Link build does not register a return scheme. The code stays as it is.

- The hand-off exists for one reason: Google refuses to sign anybody in inside an embedded web view, and
  a hosted deployment signs in with Google or Microsoft.
- A desktop with an organization authority (`organizationAuthUrl`) returns to the desktop by loopback
  (`http://127.0.0.1:<port>/organization-auth/callback`), which a phone cannot reach whatever the shell
  does.
- With no `ARK_IOS_URL_SCHEME` on the desktop's server, `/api/auth/native` is a 404 and
  `useNativeSignInReturn` never starts, so the dormant code costs nothing.

What the shell still does for the web app: it appends `ArkStoreApp/ios` to the user agent, so the
desktop's pages show nothing to buy inside the App Store app.

## Comments

**18 Nov, after Amgad's decision (06:40) and B's design.** Sign-in on the desktop install is required
before pairing (option b). The phone never signs in:

- The person signs in with their ArkAgent account **on the desktop**, then pairs the phone there.
- A paired phone acts as the person who confirmed it on the desktop, with that person's role.
- Google and Microsoft sign-in cannot finish through the relay, so through Ark Link `/api/auth/*`
  answers "Sign in on your computer". The iOS shell never shows a sign-in, and needs no scheme.

This supersedes the first version of this note, which assumed a desktop with no sign-in at all
(`OPENBOT_SINGLE_USER`).
