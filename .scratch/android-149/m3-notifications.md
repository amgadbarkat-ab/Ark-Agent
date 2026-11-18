# M3 (design only): notifications, desktop → relay → phone

Status: open (design). Nothing here is built. Takes in sub-agent C's request 4 (18 Nov).

## What exists

- The server sends Web Push today (`server/src/push/`): VAPID keys of the deployment, subscriptions
  per device, sent when a routine finishes, fails or is switched off. A notification never says what a
  routine was or produced.
- Through Ark Link, the phone's page runs on the **link host**, so its service worker and its push
  subscription belong to the link origin, not to the desktop's.

## The design

The relay sends the notification; the desktop only says "this device, this kind, this conversation".

1. **Register** (phone → relay): `POST /_link/push/register` with the device cookie (or
   `Authorization: ArkLink`), body one of:
   - `{ kind: "webpush", subscription: PushSubscriptionJSON }`: Chrome, including the Android TWA. The
     page subscribes with the **relay's** VAPID public key (served at `GET /_link/push/key`).
   - `{ kind: "apns", token: string, environment: "production" | "sandbox" }`: the iOS shell's native
     token (C).
   The relay keeps it beside the device route (by device id, in `devices.json`), one per device,
   replaced on each register, dropped when the device is removed or the push service says it is gone.
2. **Send** (desktop → relay, over the desk socket), a new control frame:
   `{ t: "push.send", id, deviceId, kind: "routine.finished" | "routine.failed" | "approval.waiting" | …,
   channelId?: string }`. No text from the conversation. The relay refuses a `deviceId` that is not
   one of that install's routed devices.
3. **Result** (relay → desktop): `{ t: "push.result", id, deviceId, outcome: "sent" | "no-subscription"
   | "gone" | "failed" }`. `gone` (Web Push 404/410, APNs `Unregistered`) also drops the subscription.
4. **The words** are fixed per `kind` and per language on the relay ("Μια ρουτίνα ολοκληρώθηκε" /
   "A routine finished"), and the tap opens `https://<link host>/channel/<channelId>` (or `/approvals`),
   which the TWA or the shell opens through the relay to the right desktop.
5. **Which devices** to notify is the desktop's choice: the person's own paired phones. With sign-in
   required for pairing (option b), the desktop knows which person confirmed each device; the device
   row gains `userId` so "notify Maria" maps to Maria's phones only.

All additive to the contract: new `t` values are ignored by peers that do not know them, so no version
bump. `ARK_LINK_PATHS` gains `pushKey` and `pushRegister`.

## Keys it needs

| Key | For | Where it lives | Needs |
|---|---|---|---|
| VAPID key pair (P-256) | Web Push to Chrome / the Android TWA | the relay's `.env`, generated once (`deploy.sh push-keys`) | no account; Amgad's yes to generate and keep it |
| APNs auth key (`.p8`), its key id, team id, the app's bundle id | iOS shell notifications | the relay's `.env`, hidden prompt | the Apple Developer account (on hold) |
| FCM | not needed for the TWA: Chrome's push service takes VAPID alone. Only if a native Android app replaced the TWA. | — | — |

The desktop never holds a store key. A customer's desktop that is off still cannot notify (it decides
what happened), which is the honest limit: the relay knows nothing about routines.

## Open points

- **Notification delegation** in the TWA (the notification shows as the app's, and Android 13 asks the
  permission in the app): an addition to the manifest and a small service in `androidbrowserhelper`. With
  it, Web Push still carries the message.
- **One subscription per origin** in Chrome: a phone paired with one desktop has one; pairing with a
  second desktop would replace the first (already true of the `ark_link` cookie).
- **Rate**: the relay caps `push.send` per install (e.g. 60 a minute) so a runaway routine cannot flood
  a phone.
- **Privacy**: the relay sees that a notification of a kind went to a device. It never sees content.
