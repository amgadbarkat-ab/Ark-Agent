# Mobile apps: Android and iOS

Written 2026-10-09. This is the decision record for Phase 6 and the list of what has to come from the
owner. It answers open question 2 in 01-product-decisions.md with a default and says what would change it.

## The decision in short

1. **One web app, on every phone, first.** Ark's web app installs to a phone's Home Screen, works
   offline enough to say so, and sends notifications. That is already built and is what most people
   will use before any store listing exists.
2. **Android in Google Play: the web app inside a Trusted Web Activity.** Chrome itself, with no
   address bar. Sign-in with Google works (it is a real browser), notifications work (same Web Push as
   the browser), and there is no second app to keep in step.
3. **iOS in the App Store: a thin native shell around the web app** (Capacitor). It has to be a shell,
   because Apple has no equivalent of a Trusted Web Activity. It signs in through the system browser,
   because Google refuses sign-in inside an embedded web view.
4. **A free companion app: nothing in either store app sells, prices, or points to somewhere to buy.**
   Customers sign up and pay on the website. This is the default because it keeps the stores' share
   out of a EUR 50 to 250 a month subscription and keeps Paddle the only seller. It is the owner's
   decision to keep or change (see "Store rules", below).
5. **A person's own desktop is not reachable from a phone yet.** The relay it would need is deferred
   (see "Not built").

Rejected, and why:

- **Tauri 2 mobile or React Native:** a second client to build, test and keep in step with the web
  app, for a product whose screens are all configuration and conversation. Nothing the web app cannot
  do is needed from the phone's hardware.
- **Capacitor for Android as well as iOS:** it puts the app in an Android web view, which Google
  refuses to sign in to and which cannot receive Web Push. It would need its own notification path
  (Firebase) and its own sign-in hand-off. A Trusted Web Activity needs neither.

## What is built

| Piece | Where | State |
| --- | --- | --- |
| Installable web app: manifest, icons, a service worker that never keeps anything from `/api`, an offline page | `app/public/`, `app/index.html` | Built; walked in a real browser, including with the server stopped. |
| Notifications (Web Push, VAPID): subscriptions per device, sent when a routine finishes, fails or is switched off; opt-in per device on Settings | `server/src/push/`, `app/src/components/settings/notifications.tsx` | Built and tested. **Delivery through a real push service is not verified** (needs real keys and a device). Setup in 13-azure-hosting.md. |
| `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`, from `ARK_ANDROID_APP_ID`, `ARK_ANDROID_CERT_SHA256`, `ARK_IOS_APP_ID` | `server/src/mobile/links.ts` | Built and tested. Nothing is served until the operator names the apps. |
| Nothing to buy inside the store apps | `app/src/lib/store-app.ts`, the Plan screen, `server/src/accounts/run-gate.ts`, `server/src/cloud/gate.ts` | Built and tested (below). |
| Android package (Trusted Web Activity) | `mobile/android/` | See "Android". |
| iOS shell and system-browser sign-in | `mobile/ios/` | See "iOS". |

## Store rules, and what the apps do about them

Checked 2026-10-09 against what could be read from here, which is commentary and a developer forum
rather than Apple's and Google's own pages. **Read the current text of both before submitting**; they
changed twice in the last year.

- **Apple** (App Store Review Guidelines, 3.1.3(f), free stand-alone apps): a free app that is a
  stand-alone companion to a paid web-based tool does not have to use in-app purchase, provided there
  is no purchasing inside the app and no call to action for purchase outside it. The examples Apple
  lists are voice calls, cloud storage, email and web hosting. A developer forum thread reports a
  reviewer reading that list as closed. Ark is a hosted service people pay for on the web, which is
  the same shape as cloud storage or web hosting, but **a reviewer may disagree**, and the answer is a
  written explanation in the review notes and, if needed, an appeal.
- **Google** (Play Payments policy): apps that sell digital goods in the app must use Play Billing.
  From 2026-06-30 Google also offers programs for alternative billing and for linking out to a
  website, in the US, UK and EEA first, with a reduced service fee. A free app that sells nothing is
  outside the policy; how Google treats an app whose account is created on the website could not be
  confirmed from here.

So the default is the companion app, and **inside either app the same pages simply do not sell**:

- A page is "inside a store app" when the iOS shell's user agent says so, or when Chrome was opened by
  the Android app's own package (`android-app://<package>`, compared with the package the server
  names, because the Google app opens the site the same way and is not Ark's). It only ever hides
  things, so faking it gains nobody anything.
- The Plan screen shows the plan, its state and how many coworkers are working, and **no plans, no
  prices, no billing, no cancel, no cloud add-on, and no sentence about choosing or changing a plan**.
  An account with no plan is told "This account does not have an active plan."
- The server's messages that offer an upgrade or the cloud add-on are each written as **one whole link
  to `/settings/plan`**, as their own sentence. The app leaves the link out, and what is left is still a
  message. Anything new that offers a purchase in a message must be written the same way. A test for
  each message holds this.
- Marketplace, conversations, routines and settings are unchanged: nothing there is sold.

**Left as it is, and why it is acceptable:** when an account that has no plan tries to start a
coworker, the refusal says "Choose a plan to start your digital employees." It has no price and no
link, and it is only seen by a person whose account has no plan. The review account given to Apple and
Google must be on a plan.

**What the companion approach costs.** Somebody who installs the app with no account cannot find out
there how to get one. The listing, the website and marketing say so, outside the app. The app may not.

**What would change this.** If the owner wants purchase inside the apps: Apple requires in-app
purchase (or, in the US, a link-out under its current terms) and Google requires Play Billing or its
alternative programs; Paddle cannot be the seller there, so the plan would also have to be sold, taxed
and reconciled through the stores for those customers. That is a decision with a price, not a patch.

## Sign-in

Ark signs in with Google, Microsoft or the company's directory (decision D9).

- **Android (Trusted Web Activity):** the site is open in Chrome, so every provider works as it does in
  the browser, and the session is shared with Chrome. Nothing to build.
- **iOS shell:** Google refuses sign-in inside an embedded web view, so the shell opens sign-in in the
  system browser and receives the result by a one-time code (see "iOS").
- **Home Screen web app on iOS:** works as in Safari.

## Notifications

Web Push everywhere a browser can receive it: Chrome, the Android app (it is Chrome), and the Home
Screen web app on iOS 16.4 or later (not in an ordinary Safari tab, which the Settings screen says).
A notification never says what a routine was or what it produced.

The iOS **store** shell is a web view, and Apple does not allow Web Push in one. If the shell is to
notify, it needs Apple's push service (APNs) with a key from the owner's Apple developer account and a
second sending path on the server. That is part of "iOS" and is not built.

## What the owner has to provide

Nothing below can be done from here. Each item blocks the thing after it.

1. **The brand and the domain** (decision D8). The store listings, the icons, the app names and the
   package and bundle identifiers all depend on them, and a package name cannot be changed after
   publishing. None has been invented.
2. **A Google Play Console account** (one-off fee, identity verification, and for a new personal
   account a closed test with testers before production). The package name, then the **App signing
   key certificate fingerprint** from Play Console, for `ARK_ANDROID_CERT_SHA256`.
3. **An Apple Developer Program account** (annual fee; for an organisation, a D-U-N-S number, which
   takes time). The team id and bundle identifier for `ARK_IOS_APP_ID`, signing certificates and, for
   notifications in the shell, an APNs key.
4. **Review accounts** for both stores: an account on a plan, with something in it.
5. **A privacy policy address and the store questionnaires** (data safety on Google, privacy labels on
   Apple). The privacy notice in docs/legal is the starting text; the lawyer's review comes first.
6. **A decision on open question 2** if the default above is not wanted.

## Not built

- **Reaching a person's own desktop from a phone.** It needs a relay the desktop connects out to, with
  its own authentication and abuse limits, and it is a security-sensitive piece of its own. Deferred
  until there is a reason to take it on.
- **Native notifications in the iOS shell** (APNs), as above.
- **Anything in the stores' own review process,** which can only be learned by submitting.

## Exit test

On a real Android phone and a real iPhone, with the owner's accounts: install from a store's test
track, sign in with Google, switch notifications on in Settings, have a routine finish with the app
closed and see the notification, open it and land in the right conversation; and confirm that nothing
in either app shows a price, a plan to choose, or a link to buy.
