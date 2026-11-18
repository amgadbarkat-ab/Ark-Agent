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

## A finding that needs a decision

A desktop install runs with **no sign-in** (`OPENBOT_SINGLE_USER=true`, set by the desktop shell):
every request is the computer's one administrator. "Device pairing is not a sign-in" holds on a
deployment with sign-in. On a desktop, a paired phone acts as that administrator, because there is no
account to sign in to. The design keeps that safe enough for phase 1 (pairing needs a confirmation at
the desktop, tokens are 256-bit and stored hashed, removal is immediate, per-device limits) and the
Phones screen says it in a sentence. Whether to add a phone PIN or a desktop sign-in is for PE/Amgad.

## Seams under test (from PE's M1 list)

| Seam | Catches | Misses |
| --- | --- | --- |
| `shared/ark-link.ts` pure functions (frames, codes, tokens) | encoding and validation mistakes C would also hit | nothing about sockets |
| The relay through real `Bun.serve`, `fetch` and `WebSocket` | pairing, expired/reused code, routing, removed device, limits, bad token, WS pass-through, desktop offline | Caddy, TLS |
| The connector against a real relay and a stand-in local server | off by default, forwarding, device check, removal, reconnect | the real app's routes |
| `/api/ark-link` routes on the server, with the test database | admin only, settings saved, devices listed and removed | the UI |
| Settings → Phones (happy-dom) | the screen renders the code, the list, the confirm step, in Greek too | layout on a real phone |
| End to end: relay + stand-in desktop + fetch as the phone | the whole path | a real phone and Chrome |
