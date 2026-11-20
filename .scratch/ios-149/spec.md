# iOS app through Ark Link (#149)

Toolkit: Matt Pocock's skills (`/tdd` for the config and the pair-screen logic). Branch `claude/ios-149`.

The iOS app stops being a window onto one hosted deployment and becomes a window onto the customer's
own desktop ArkAgent, reached through Ark Link (a BlackArk relay the desktop connects out to). One app
for every customer, so the bundle identifier is the product's: `blackark.arkagent`.

## Milestones

- M1: the project compiles in CI for the simulator, unsigned, for the first time. The start address is
  the Ark Link host (`ARK_LINK_URL`, configurable, no default).
- M2: pair screen when there is no device token (Greek and English; typed code; QR only if Capacitor
  already gives a camera, which it does not). Token storage decision. Sign-in decision. Phone-width
  pass on the conversation screen and the approval cards.
- M3: design only, native notifications (APNs through the relay).

## Seams under test

- `iosConfigFrom` / `capacitorConfigFor` / `patchInfoPlist` in `mobile/scripts/ios-config.ts`: what a
  build is given and what Capacitor is told. Catches a wrong start address, a wrong bundle id, defaults
  slipping in. Misses anything Xcode does (that is CI's job).
- The pair screen's pure logic (code normalisation, the redeem request, what is kept): decided
  against `shared/ark-link.ts` from `claude/android-149`.

## Depends on

- `shared/ark-link.ts` (sub-agent B, `claude/android-149`): the pairing request and how the device
  token is presented to the relay (cookie or header). Not on the remote at the start of M1.
