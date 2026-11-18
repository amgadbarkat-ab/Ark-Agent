# Where the device token lives on the iPhone

Status: resolved

## Answer

In the app's web view cookie store, as the relay's `ark_link` cookie (HttpOnly, Secure, SameSite=Lax,
400 days, renewed on every page load). **Not the Keychain.**

- Capacitor's core has no Keychain API, and a plugin is not allowed here. Our own Swift plugin would
  work (Security framework, no dependency) but needs a view-controller subclass and a storyboard edit
  that cannot be tried without a Mac, and the token would still have to be copied into the cookie
  store on every launch, because the relay reads the cookie.
- Capacitor uses `WKWebsiteDataStore.default()`, which is persistent (checked in
  `CAPBridgeViewController.swift`), so the cookie survives the app being closed and the phone restarting.
- WebKit's 7-day cap applies to storage a script can write; a cookie the server set with HttpOnly on its
  own origin is not capped.
- The cookie is in the app's container, which an encrypted backup carries to a new phone. Removing the
  phone in Settings → Phones on the desktop cuts it, wherever it is.

## Comments
