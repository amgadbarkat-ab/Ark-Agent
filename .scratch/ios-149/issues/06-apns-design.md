# M3 (design only): notifications in the iOS app, through Ark Link

Status: open

Nothing here is built. It needs the owner's yes for an Apple key, a native piece in the app, and one
outbound service from the relay.

## Why the relay sends them, not the desktop

APNs is authenticated with one key for BlackArk's Apple team. Putting that key on every customer's desktop
would hand it to every customer. The relay is BlackArk's, already knows each paired phone, and already
holds the desktop's socket, so the desktop asks the relay to notify a device and the relay calls Apple.

## The flow

1. **Phone registers.** On launch, after the person allows notifications, iOS gives the app an APNs device
   token. The app posts it to the relay, `POST /_link/push/register {apnsToken, environment:
   "sandbox" | "production"}`, carried by the `ark_link` cookie. The relay keeps it against that device
   (hashed device token → APNs token) and drops it when the device is removed or Apple answers 410.
2. **Desktop asks.** When a routine finishes, fails or is switched off (the same events Web Push uses,
   `server/src/push/`), the desktop sends a control frame `{t: "push.send", deviceId, kind, channelId?}`
   for each paired phone that asked for notifications.
3. **Relay sends.** It signs a JWT (ES256, the team's `.p8` key, renewed at most hourly) and POSTs to
   `api.push.apple.com` (`api.sandbox.push.apple.com` for development builds), topic `blackark.arkagent`,
   over HTTP/2. The text is generic, as for Web Push: "A routine finished" and nothing about what it
   did. `channelId` is an opaque id in the payload, so the relay sees no content.
4. **Tap.** The app opens `/channel/<channelId>` on the Ark Link host, i.e. the desktop's own page.

## Protocol additions to ask of `shared/ark-link.ts` (sub-agent B)

- `ARK_LINK_PATHS.pushRegister = "/_link/push/register"`, `PushRegisterRequest`.
- `DeskMessage` `{t: "push.send"; deviceId; kind: "routine.finished" | "routine.failed" |
  "routine.disabled"; channelId?}` and `RelayMessage` `{t: "push.result"; deviceId; ok; gone?}`.
  New message types, so no version bump.

## What the app needs

- The Push Notifications capability (`aps-environment` entitlement). Only a signed build with a
  provisioning profile from the Apple developer account can carry it; the unsigned simulator check
  builds without it.
- Native code to ask permission, receive the token and handle a tap. Either `@capacitor/push-notifications`
  (Capacitor's own plugin, v8, a **new dependency**) or about a hundred lines of our own Swift in
  `AppDelegate`. Recommendation: the plugin, pinned, because it is Capacitor's and is maintained with it.

## Needs Amgad's yes

- Apple Developer Program membership (team id).
- An **APNs auth key** (`.p8`, its Key ID, the Team ID), held only by the relay. One key serves
  development and production.
- The Push Notifications capability on the `blackark.arkagent` App ID.
- The relay calling `api.push.apple.com` / `api.sandbox.push.apple.com` (a new outbound service).
- `@capacitor/push-notifications` (or the own-Swift alternative).
- A privacy-label answer for notifications (device identifiers sent to BlackArk's relay).

## Comments
