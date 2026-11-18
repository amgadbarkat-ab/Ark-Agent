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

**A paired phone acts as one person, and never signs in** (PE, 18 Nov). Only a signed-in administrator, at
a computer, confirms a phone. It acts as that administrator, or as another active person the
administrator chose ("This phone is for"), who then accepts it in their own Settings → Phones before it
does anything. On every request:

- The connector checks the device token against the desktop's list, and that the device's person is
  still here: not removed (deny list), holding a role, and the device accepted.
- It then marks the request with this process's secret and the device id
  (`server/src/ark-link/marker.ts`). It first takes off every `x-ark-link-*` header and every header
  that names a person (`x-user-id`, `remote-user`, `x-forwarded-user`…), so a phone cannot choose its
  person.
- The server answers a marked request as the device's person (`server/src/ark-link/sessions.ts`),
  built as a signed-in session is built: same id, roles read fresh from the database, same tenant and
  boundaries, and every acting call through the gateway and audit. Cookies the phone carries are not
  read. A demoted person is the lower role on the next request; a removed device or person is nobody
  at once.
- Every audit row written for the request carries `arkLinkDevice: <device id>`.
- No OAuth and no Better Auth session ever exists for the phone. `/api/auth/*` answers 409 "Sign in on
  your computer", `/sign` redirects to `/`, and a connector's OAuth start answers "Connect this on your
  computer". Phones cannot pair or manage phones; they can only see and remove their own.

**Pairing needs sign-in** (Amgad, 18 Nov, option b): on an install that runs with no sign-in
(`OPENBOT_SINGLE_USER=true`, every request its one administrator), Settings → Phones says in Greek and
English that sign-in must be switched on first, the server refuses to switch Ark Link on or to start or
confirm a pairing, and the connector never connects.

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

- **A Linux host in the EU with Docker and the compose plugin** (the Oracle Always Free VM; see "What it
  needs from a host"). Sharing it with the phone relay means one Caddy for both; as written here, the
  directory also runs on its own with its own Caddy on ports 80 and 443.
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
bun test infra/ark-link shared/ark-link.test.ts          # both relays (Bun, and Workers over stand-ins), and the contract
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

**One origin for every customer.** All desktops are served on the link host, so a phone that pairs with
a second desktop would carry the first one's sign-in cookies, service worker and storage to it. The
relay clears the site's data on the phone when it claims a code (`Clear-Site-Data`), and the desktop can
never set or overwrite the device cookie. Separate origins per install (`<install>.link.blackark.uk`, a
wildcard certificate by DNS challenge) would make this structural rather than procedural; it is the
next step if one phone is ever meant to reach two desktops.

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

## What it needs from a host

For a VM (the Oracle plan of 18 Nov morning was dropped at 10:56; see "On Cloudflare Workers" for the
proposal now on the table): Ark Link, the phone relay and the Control Board in Docker behind **one
Caddy**. This directory follows `infra/phone-relay/`: a plain
Bun service, a Dockerfile, and a compose service (`relay`) that can join that shared compose file (build
context the repository root, `infra/ark-link/Dockerfile`, `./data` mounted at `/data`, port 8080 inside)
or run beside it with its own Caddy as here. In a shared Caddyfile it is one more site block:
`link.blackark.uk { reverse_proxy ark-link:8080 { stream_close_delay 5m } }`.

- **Long-lived WebSockets, both ways.** One per connected desktop (outgoing from the desktop, open for
  days), plus one per open phone screen that uses a socket (the conversation stream). The proxy must not
  cut idle sockets: the relay pings desktops every 25 s, and the app's own streams beat every 8 s.
- **Connections.** For the first test: a handful of desktops and phones, so tens of sockets. Planned
  for: a few hundred desktops, each with up to 32 open requests or sockets per phone. Bun holds tens of
  thousands of idle sockets on one core.
- **Memory.** Measured here (`.scratch/android-149/measure-relay.ts`): about 47 MB for Bun at rest,
  57 MB with 300 desktops connected and 66 MB with 1,000 (both ends of every socket in the one process,
  so the relay alone is less). Plus what is in flight: bodies pass in 64 KB frames, and the desktop waits
  when its socket is backed up, but the relay queues an answer for a phone that reads slowly (up to the
  64 MB response cap per stream; in practice pages and messages are kilobytes). A 256 MB limit is generous for the first
  year; the phone relay and Caddy fit beside it in 1 GB.
- **State across restarts.** Only `data/installs.json` and `data/devices.json` (hashes and routing,
  a few KB). Everything else is rebuilt: desktops reconnect on their own (back-off up to a minute) and
  send their device list again, a pairing in progress is simply started again, and an open phone page
  reloads. No database.
- **One process per host**, because desktops' sockets and the pairing codes are in its memory.

## On Cloudflare Workers + Durable Objects (`worker/`)

Oracle was dropped (its sign-up needs a credit card, Amgad 18 Nov 10:56). PE proposes Workers + Durable
Objects on the **Free plan** for Ark Link; **not decided, not deployed**. Both relays exist and are
tested: the Bun one (this directory, Docker) and the Workers one (`worker/`). They share the logic:
`desk-link.ts` (one desktop's streams), `directory.ts` (routes and pairings) and `edge.ts` (the relay's
own paths). The platform parts are thin:

| Part | Bun | Workers |
|---|---|---|
| Desktop's socket | `Bun.serve` WebSocket, in memory | one **Install** Durable Object per install, socket held with the **Hibernation API** |
| Phone requests | in-process | the Worker finds the install by the token's hash (asks the **Directory** object, caches 30 s), then the install object streams the request and answer through |
| Phone sockets | `server.upgrade` | `WebSocketPair` accepted by the install object, stream id in the socket's attachment, so it survives hibernation |
| Routes, codes, pairings | maps + `data/devices.json` | the **Directory** object's SQLite (SQLite-backed objects are the only kind on Free) |
| Heartbeat | answered in-process | `{"t":"beat"}` answered by the runtime's auto-response: an idle desktop never wakes its object |
| Installs | `data/installs.json` | `LINK_INSTALLS` variable (hashes only) |
| Expiry | a 30 s timer | the Directory's alarm, once a minute while codes or pairings exist |

No `wrangler` or `@cloudflare/workers-types` in the repository: `worker/types.ts` declares the few
types used, and `worker/wrangler.toml` is written by hand. No R2, KV, Access or Zero Trust (those need
payment details on the account). Tests: `bun test infra/ark-link/worker` runs the real connector against
the Worker and both objects over stand-ins (`worker/stand-ins.ts`: namespaces, state with
`bun:sqlite`, accepted sockets with tags and attachments, auto-response, eviction as hibernation).

### Free plan, as Cloudflare's pages say (read 18 Nov 2026)

Workers: 100,000 requests a day; 10 ms CPU per request; 50 subrequests; 128 MB. Durable Objects on Free:
SQLite backend only; 100,000 requests a day; 13,000 GB-s of duration a day; incoming WebSocket messages
billed 20 to 1 (outgoing free); auto-responses not billed and not woken; idle hibernating objects accrue
no duration; SQLite 5 million rows read and 100,000 written a day, 5 GB stored. Limits reset 00:00 UTC;
over a limit, that kind of operation **fails** until then (an outage, not a bill).

### What Ark Link would use

Per phone request: 1 Worker request, 1 Durable Object request (the install), the directory at most once
per 30 s per isolate, and the desktop's answer as incoming messages (head, body frames, end: about 3,
so 0.15 of a request). A streamed chat reply is one frame per chunk the desktop's server writes: say 500
frames, 25 requests.

| Usage | Workers requests | DO requests | DO duration |
|---|---|---|---|
| One phone, one hour of active use (≈400 requests: page loads, the 15 s polls, 20 chat replies) | ≈400 | ≈1,100 | ≈230 GB-s (awake about half the hour, 128 MB) |
| **First test: 3 desktops, 3 phones, an hour a day each** | ≈1,200 (1.2 %) | ≈3,300 (3.3 %) | ≈700 GB-s (5 %) |
| An idle desktop, all day | 0 | 0 (heartbeats are auto-responses) | 0 |
| The Free ceiling | | ≈90 active phone-hours a day | ≈55 active phone-hours a day |

So the first test uses a few percent of the day. Roughly 50 active phone-hours a day is where Free
stops.

### What does not fit, or fits awkwardly

- **More than about 50 active phone-hours a day**, mostly from streamed chat replies (frame count).
  Over it, requests fail until 00:00 UTC. Workers Paid lifts it.
- **Rate limits per address and per device** live in an isolate's or an object's memory, so they are
  approximate (per isolate, reset on eviction). The desktop still checks every token.
- **A deploy drops every socket.** Desktops reconnect on their own; a pairing in progress starts again.
  The directory's "connected" row can be stale until that desktop reconnects (a claim then waits and
  expires).
- **No logs.** Observability is off on purpose; nothing about traffic is kept.

### Token scopes COO needs to create (for `wrangler deploy`, not stored here)

One API token, from the "Edit Cloudflare Workers" template, narrowed to:

- Account → **Workers Scripts: Edit** (the script and its Durable Object classes)
- Account → **Account Settings: Read**
- Zone `blackark.uk` → **Workers Routes: Edit** and **DNS: Edit** (the `link.blackark.uk` custom domain)
- User → **User Details: Read** and **Memberships: Read** (wrangler checks who it is)

No R2, KV, D1, Access, Zero Trust or Pages scopes. Check the template's current names before
creating it.

### The phone relay on Workers Free (estimate only, not built)

A call's media socket carries about 50 messages a second from Twilio, and the install sends about as
many back: about 100 incoming messages a second, so about 300 Durable Object requests a call-minute.
100,000 a day is therefore about **5.5 call-hours a day** on Free; duration (128 MB awake for the
call) would allow about 28. It fits a pilot, not a shop's phone line. Twilio's signature check and the
billing calls fit the CPU limit; the SMTP alert would need `cloudflare:sockets`.
