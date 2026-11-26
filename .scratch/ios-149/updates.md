# Updates and the iOS app (#149)

Written 18 Nov 2026 for PE and sub-agent B. Context: Amgad approved automated updates for customers
in principle (18 Nov, 06:26); store accounts and signing are on hold until the apps work.

## What "an update" is, for the iOS app

The iOS app is a window. Everything a person sees after pairing comes from **their own desktop**,
through the relay: screens, wording, translations, fixes, layout. Nothing of the web app is bundled.
The pair page and the "computer is not connected" page come from **the relay**. There is no sign-in on
the phone: the person signs in with their ArkAgent account on the desktop, before pairing, and a paired
phone acts as the person who confirmed it there, with that person's role. Through Ark Link
`/api/auth/*` answers "Sign in on your computer", so no update of the shell ever needs to carry a
sign-in.

So there are three things that update, on three schedules:

| What | Who ships it | How a phone gets it | App Store build? |
| --- | --- | --- | --- |
| The web app (every screen after pairing) | The desktop's automated update | The next page load from that desktop | No |
| The pair, offline and not-paired pages | A relay deploy | The next page load from the relay | No |
| The shell itself (native code, `Info.plist`, Capacitor) | A new build in App Store Connect | The App Store's own update | Yes |

A paired phone shows whatever version its desktop runs. Two phones paired with two desktops can show
two versions, and that is correct: each shows its own desktop.

## When the shell itself needs a new App Store build

Only when something native changes:

1. **The Ark Link host or its rules:** `ARK_LINK_URL`, `allowNavigation`, the user agent token, or the
   app's own "cannot be reached" page (`mobile/ios/www/index.html`, which is bundled).
2. **`Info.plist` or entitlements:** a new permission reason (location, photos library writes,
   notifications), Push Notifications or Associated Domains (universal links), the name or icon.
3. **A native plugin added or removed**, for example `@capacitor/push-notifications` for M3.
4. **Capacitor itself**, for a security fix or when Apple requires a newer SDK. Apple raises the
   minimum Xcode and iOS SDK for *new uploads* about once a year (usually April); builds already in the
   store keep working, so this forces a build only when we next upload anyway.
5. **A change in iOS** that breaks the web view's behaviour, found on a real iPhone.

Not a reason for a new build: any change to the desktop's app, the relay, the pair page, the wording,
the Greek, the layout, or the protocol between desktop and relay.

## Keeping an old shell working with a newer desktop (and the other way round)

The shell's whole contract with everything else is small, and it is what must not break:

- **HTTPS to one host, the `ark_link` cookie, and the relay's paths** (`/`, `/_link/pair`, a 302 from
  `/` to the pair page for an unpaired page load, 401 JSON for an unpaired script request). The relay
  must keep these stable for as long as any shell in the store uses them. Today the protocol version
  (`ARK_LINK_PROTOCOL_VERSION`) covers desktop and relay only; nothing versions the phone side.
- **The user agent token `ArkStoreApp/ios`.** The desktop's web app hides everything to buy when it
  sees it (App Store rule 3.1.3(f)). It must never be renamed. A new token can be *added* after it.
- **The native plugins the shell carries** (today `@capacitor/app` and `@capacitor/browser`). The
  desktop's web app must **detect** a plugin before using it (`Capacitor.isPluginAvailable("…")`) and
  carry on without it, never assume it, because a phone can run an older shell than the desktop
  expects. The same holds the other way: a newer shell must not assume a newer desktop.
- **Nothing cached that outlives a desktop update.** The web view does not run the web app's service
  worker (that needs App-Bound Domains, not set), so a page load always asks the desktop. The desktop
  must keep serving `index.html` uncached and its scripts under content-hashed names, as Vite does.

Rules for whoever changes the web app, in one line each:

- Feature-detect native plugins; never require one.
- Never rename `ArkStoreApp/ios`.
- A relay path the phone uses is changed only by adding a new one beside it.

## Proposal for B: a shell level in the user agent

Small, no new request, no native code beyond one setting, and it reaches the relay and the desktop on
every request, sockets included:

- The shell appends `ArkStoreApp/ios ArkShell/<level>` instead of `ArkStoreApp/ios` alone (Capacitor's
  `appendUserAgent`). `<level>` is a whole number that goes up **only when the native surface changes**
  (items 1–3 above), not with every build. A shell without it is level 0.
- `shared/ark-link.ts` gets `shellLevelFrom(userAgent): number` (`/\bArkShell\/(\d+)\b/`, else 0) and a
  `MIN_SHELL_LEVEL` the relay is configured with, 0 by default.
- The relay, on a page load from a shell below the minimum, answers with an "update the app" page in
  Greek and English (a plain link to the App Store listing; it sells nothing, so it is allowed). Used
  only for a change that makes old shells unsafe or broken, never to push people along.
- The desktop's web app reads the same level to decide whether to offer a feature that needs a plugin
  (for example, notifications from level 2).
- Android: the Trusted Web Activity is Chrome, whose user agent the app cannot change. The same level
  can ride on the launch address (`/?ark_shell=<level>`, kept in the session like `android-app://`
  already is in `app/src/lib/store-app.ts`).

The iOS half is one line in `mobile/scripts/ios-config.ts` and a test. I have not made it: it changes
what the relay and the desktop see, so it waits for B's and PE's yes. Nothing has shipped to the
store, so every build so far is "level 0" without harm.
