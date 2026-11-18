# Ark Link relay (#149)

Lets a phone reach the customer's own desktop ArkAgent. **Built and tested locally only. Deploying it
needs Amgad's yes** (a VPS, a DNS name, and the certificate Caddy gets for it).

- **Why it is needed:** the desktop sits behind the customer's router, so a phone cannot call into it.
- **How it connects:** the desktop keeps one outgoing WebSocket open to this relay, and the relay passes
  each paired phone's requests over it.

```
phone (Android app, iOS shell, a browser)
  ── https / wss, ark_link cookie or Authorization: ArkLink <device token> ──▶ relay
relay ◀── wss /_link/desk, Authorization: Bearer <install token> ── desktop (outgoing)
desktop: checks the device token again, makes the request to its own server on 127.0.0.1, streams back
```

The wire contract is [`shared/ark-link.ts`](../../shared/ark-link.ts): the paths, the pairing JSON, the
frames and the limits. The desktop side is `server/src/ark-link/`; an administrator switches it on in
Settings → Phones (it is off by default).

## Pairing

1. On the desktop, an administrator opens **Settings → Phones → Pair a phone**. The desktop asks the relay
   for a code: **8 characters, single use, valid 5 minutes**, shown as `ABCD-EFGH` and as a QR code of
   `https://<link host>/_link/pair?code=…`.
2. The phone opens that page (or the Android app, which starts there when it is not paired), enters the
   code and its name. The relay spends the code and tells the desktop.
3. The desktop shows the phone's name; the person confirms (and may rename it).
4. The desktop makes a device token, keeps its SHA-256 and the name, and passes the token to the relay,
   which hands it to the phone once (as the HttpOnly `ark_link` cookie, and in the JSON for the iOS
   shell), then keeps only the hash.

**Removing** a phone in Settings → Phones deletes it on the desktop, ends its open requests and sockets,
and replaces the relay's list. The desktop checks every request against its own list, so a removed
phone is refused even if the relay is behind.

**Pairing is not sign-in.** Every request still goes through the desktop's own sign-in. A desktop install
runs with no sign-in (one administrator, `OPENBOT_SINGLE_USER`), so there a paired phone acts as that
administrator; Settings → Phones says so. See "Open question" below.

## What it keeps

- **No bodies, paths, headers or tokens in logs.** Logs say when a desktop connects or drops and when a
  pairing starts, is claimed or is confirmed, by install id and device id.
- **`data/installs.json`:** each install's id and the **SHA-256** of its install token.
- **`data/devices.json`:** each paired device's id, its install and the **SHA-256** of its device token
  (routing only; the names stay on the desktop). The desktop sends its full list every time it connects.
- **In memory:** connected desktops, pairing codes (5 minutes), pairings waiting for a person (5
  minutes), open streams, rate-limit buckets.
- **`.env`:** the domain and the store apps' names. **No secrets.**

## What it trusts

| From | Checked by |
|---|---|
| A desktop | its install token, SHA-256 compared to `installs.json`; protocol version header |
| A phone | its device token (cookie or `ArkLink` header), SHA-256 compared to the device routes; the token is taken off the request before forwarding, and the desktop checks it again |
| A pairing claim | the code: once, 5 minutes, and only for the desktop that asked; then a person at that desktop |
| A desktop's confirmation | only for a pairing claimed on a code that desktop started, and the token must match the hash it names |
| A write to `/_link/*` | no `Origin`, or the link's own origin |

## Limits (defaults in `ARK_LINK_LIMITS`)

| Limit | Default |
|---|---|
| Requests per device | bucket of 120, refilled at 600 a minute |
| Open requests and sockets per device | 32 |
| Request body | 16 MB (the app's largest is a message with attachments) |
| Response body | 64 MB |
| One WebSocket message | 1 MB |
| HTTP stream idle | 60 s (the app's streams send a keep-alive every 8 s) |
| WebSocket idle | 10 minutes |
| Desktop's answer to a request | 30 s |
| Desktop pings | every 25 s; dropped after about a minute of silence |
| Pairing claims per address | 10 a minute |
| Pairing polls per address | 120 a minute |
| Unknown or missing tokens per address | 60 a minute |

When the desktop is off, a paired phone gets a page in Greek and English ("Ο υπολογιστής σας δεν είναι
συνδεδεμένος / Your computer is not connected"), or `503 {code: "ark_link_offline"}` for a script.

## Requirements (needs Amgad's yes)

- **A Linux VPS in the EU with Docker and the compose plugin.** The phone relay's kind (1 vCPU, 512 MB)
  is enough for a few hundred phones. It can share a VPS with the phone relay only behind one Caddy; as
  written, each has its own Caddy on ports 80 and 443.
- **A DNS name**, for example an A record `link.blackark.uk`, and ports 80 and 443 open.
- **Images:** `oven/bun:1.3.14-slim` and `caddy:2.10.2-alpine`. Nothing else is installed.
- **One copy per host.** State is per process.

### Environment (`.env`, written by `setup`)

| Variable | Example | Secret |
|---|---|---|
| `LINK_DOMAIN` | `link.blackark.uk` | no |
| `LINK_ORIGIN` | `https://link.blackark.uk` | no |
| `ARK_ANDROID_APP_ID` | `blackark.arkagent` | no |
| `ARK_ANDROID_CERT_SHA256` | Play Console's App signing key fingerprint, comma-separated | no |
| `ARK_IOS_APP_ID` | `TEAMID.blackark.arkagent` | no |
| `TRUST_PROXY` | `true` (default; Caddy sets `X-Forwarded-For`) | no |

### Endpoints

| Who | Endpoint |
|---|---|
| desktop ↔ relay | `wss /_link/desk`, `Authorization: Bearer <install token>`, `ark-link-version: 1` |
| phone | `GET /_link/pair`, `POST /_link/pair/claim`, `POST /_link/pair/status`, `POST /_link/forget` |
| Android, iOS | `GET /.well-known/assetlinks.json`, `GET /.well-known/apple-app-site-association` |
| anyone | `GET /_link/health` → `ok` |
| a paired phone | everything else, passed to its desktop |

## Deploy (not done; needs Amgad's yes)

```bash
git clone --depth 1 https://github.com/amgadbarkat-ab/Ark-Agent.git && cd Ark-Agent/infra/ark-link
./deploy.sh setup                 # the domain, and optionally the Android and iOS app names
./deploy.sh add-install demo-shop # prints the install token ONCE, for Settings → Phones on that computer
curl -fsS https://link.blackark.uk/_link/health   # ok
```

Other commands: `./deploy.sh installs | remove-install <id> | status | logs | restart | update`.

## Test (on any machine with Bun)

```bash
bun test infra/ark-link shared/ark-link.test.ts          # the relay, and the contract
bun test server/tests/ark-link-end-to-end.test.ts        # relay + stand-in desktop + fetch as the phone
bun test server/tests/ark-link.integration.test.ts       # Settings → Phones routes (TEST_DATABASE_URL)
```

## Security: phase 1 and phase 2

**Phase 1 (this) is TLS to the relay.** The phone's TLS ends at Caddy on BlackArk's relay, and the
desktop's TLS ends there too. Between them the relay sees every request and answer in the clear: it
could technically read the customer's conversations, approvals and cookies, and the device token once at
pairing. It is built not to (no bodies, paths or tokens logged or stored), but that is a promise about
BlackArk's code and server, not a property of the design. A compromised relay could also forge requests
for a phone it has seen.

**Phase 2 (proposed, not built): end-to-end encryption between phone and desktop.** The relay keeps
routing by device id and carries only ciphertext.

- At pairing, the desktop shows its public key's fingerprint in the QR code (`#k=` in the URL, which never
  reaches the relay), and the phone makes a key pair and sends its public key with the claim. The person
  confirming the name also confirms a short code both screens derive from both keys (as Signal's safety
  numbers), which defeats a relay that swaps keys.
- Each phone ↔ desktop session runs a Noise `IK` (or `XX`) handshake over the relay's stream, then
  ChaCha20-Poly1305 frames. Web Crypto in Chrome has X25519 and AES-GCM, so the Android app's Chrome can
  do it in a service worker; the iOS shell can do it natively.
- The hard part is that the TWA is Chrome loading pages from the link host: the relay serves the page, so
  a malicious relay could serve script that leaks the keys. Real end-to-end needs the shell to hold the
  code (a small signed bootstrap the app ships, which then only talks ciphertext through the relay), so
  phase 2 is an Android app change too (a bundled page, or Capacitor on Android, which 19-mobile.md
  rejected for sign-in and push reasons). That trade-off is the decision to make before building it.

## Open question

On a desktop install with no sign-in, the device token is the only thing between the internet and that
computer's administrator. Pairing needs a person at the desktop, tokens are 256-bit and stored hashed,
removal is immediate and every pairing and removal is audited, but a stolen phone with an open cookie is
that administrator until removed. A phone PIN, or a sign-in on the desktop, would close it; that is
PE's and Amgad's call.
