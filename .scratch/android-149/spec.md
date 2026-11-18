# Android app and Ark Link (#149)

Toolkit: Matt Pocock's skills (`/tdd`, then `/code-review`). Branch `claude/android-149`.

## What it is

A phone reaches the customer's own desktop ArkAgent through **Ark Link**:

1. **Relay** (`infra/ark-link/`): a Bun service on an EU VPS behind Caddy at one fixed host
   (configurable, for example `link.blackark.uk`). The desktop holds one outgoing WSS to it.
2. **Desktop connector** (`server/src/ark-link/`): the server owns the app's HTTP server on the desktop,
   so the connector lives there. Off by default; an administrator switches it on in Settings → Phones.
3. **Phone side**: the pairing page on the relay, then the desktop's own app through the relay.

The wire contract is `shared/ark-link.ts`. Sub-agent C (iOS) builds against it; keep it stable and
bump `ARK_LINK_PROTOCOL_VERSION` for any incompatible change.

## Deviations from PE's plan, with reasons

- **Relay paths are under `/_link/`** (`/_link/pair/claim`, not `/pair/claim`). The relay shares its
  origin with the proxied app, so its own paths must never shadow an app path. Only
  `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` sit outside it, because
  Android and iOS look there.
- **`pair.start` is a control frame, not an HTTP request**, over the desktop's socket. It does the same
  thing: the desktop asks, the relay answers `{code, expiresAt}`.
- **The phone polls `POST /_link/pair/status {pairingId}`** after claiming, and receives
  `{deviceToken}` once, when the desktop has confirmed.
- **The desktop generates the device token** and holds only its SHA-256. It passes the token once to the
  relay to hand to the phone (phase 1: the relay sees traffic anyway). The desktop checks the token on
  every forwarded request, so removing a device on the desktop cuts it even if the relay is behind.

## Decided (Amgad, 18 Nov)

- 06:26: phase 1 (TLS to the relay) approved for the first test. Store accounts and signing on hold.
- 06:40: **pairing requires sign-in** (option b). No-sign-in installs: Settings → Phones says so, the
  server refuses, the connector never connects. Only a signed-in administrator confirms.
- 06:40: OAuth connector sign-ins from a phone answer "Connect this on your computer", told by the
  connector's secret mark (`server/src/ark-link/marker.ts`).
- 06:40: hosting is an Oracle Always Free VM in the EU, behind one Caddy with the phone relay and the
  Control Board. Not Cloudflare.

## Open: phone sign-in through the link host

Better Auth runs with a fixed `baseURL` (`BETTER_AUTH_URL`), so a Google or Microsoft sign-in started on
a phone through the link host returns to the install's own address, which the phone cannot reach on an
install that is not public. Proposed: a second Better Auth instance with `baseURL =
https://<link host>/api/auth`, same database and secret, chosen for `/api/auth/*` when the request
carries the Ark Link mark; the customer adds `https://<link host>/api/auth/callback/<provider>` to their
identity provider's redirect URIs. Not built.

## Seams under test (from PE's M1 list)

| Seam | Catches | Misses |
| --- | --- | --- |
| `shared/ark-link.ts` pure functions (frames, codes, tokens) | encoding and validation mistakes C would also hit | nothing about sockets |
| The relay through real `Bun.serve`, `fetch` and `WebSocket` | pairing, expired/reused code, routing, removed device, limits, bad token, WS pass-through, desktop offline | Caddy, TLS |
| The connector against a real relay and a stand-in local server | off by default, forwarding, device check, removal, reconnect | the real app's routes |
| `/api/ark-link` routes on the server, with the test database | admin only, settings saved, devices listed and removed | the UI |
| Settings → Phones (happy-dom) | the screen renders the code, the list, the confirm step, in Greek too | layout on a real phone |
| End to end: relay + stand-in desktop + fetch as the phone | the whole path | a real phone and Chrome |
