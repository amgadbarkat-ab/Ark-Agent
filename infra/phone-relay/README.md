# BlackArk phone relay (#109)

Carries phone calls between Twilio and the ArkAgent install that answers the line.

- **Why it is needed:** the install sits behind the customer's router, so the phone network cannot call into it.
- **How it connects:** the install keeps one outgoing WebSocket open to this relay.

```
caller ── customer's line, forwarded ──▶ Twilio number
Twilio ── POST /twilio/voice (signed) ──▶ relay ── TwiML <Connect><Stream>
Twilio ◀── wss /twilio/media (μ-law 8 kHz) ──▶ relay ◀── wss /line ──▶ ArkAgent install
                                                       (outgoing from the install)
install ◀──▶ speech service (customer's own key; the relay never sees it)
```

**Two ways to run it, with the same behaviour and the same shared logic (`core.ts`):**

- **On Cloudflare Workers + Durable Objects, Free plan** (`worker/`): no server to keep.
  See [On Cloudflare Workers](#on-cloudflare-workers-free-plan). The address is
  `https://blackark-phone.blackark.workers.dev`.
- **On a Linux VPS with Docker** (`relay.ts`, Bun, behind Caddy). See [Deploy](#deploy).

## What it keeps

- **No audio, no transcripts and no speech keys.**
- **In memory only:** which install is connected for which line, and the live calls.
- **Logs:** the call id, the line name and the duration. Never a caller's number.
- **`data/lines.json`:** each line's name, Twilio number, the **SHA-256** of its line token, and the fallback number.
- **`.env`:** the Twilio Account SID and auth token, in a file with mode 600.

## What it trusts

| From | Checked by |
|---|---|
| Twilio webhooks | `X-Twilio-Signature` (HMAC-SHA1 with the auth token), and the Account SID must match |
| Twilio's media socket | the one-time key the signed webhook handed out for that call (30 s, single use) |
| An install | its line token (SHA-256 compared to `lines.json`); it can only act on calls on its own line |
| The hand-over number | `lines.json` only; the install cannot choose a number |

If the install is not connected, or drops mid-call, the caller goes to the line's fallback number. With no fallback, the caller hears a short Greek message.

## Requirements

- **A Linux VPS in the EU with Docker and the compose plugin.** 1 vCPU, 512 MB RAM and 1 GB disk are enough for a few calls at once. One.com shared hosting cannot run it: it can't hold WebSockets open.
- **A public IPv4 address and a DNS name** pointing at it, for example an A record `phone.blackark.uk`.
- **Ports 80 and 443 open.** Caddy gets the Let's Encrypt certificate on its own, because Twilio needs `https://` and `wss://` with a real certificate.
- **Outbound HTTPS to `api.twilio.com`**, used only for hand-overs and hang-ups.
- **With billing (v0.1.47):**
  - outbound HTTPS to `blackark.uk`, for the balance and the charges;
  - outbound SMTP over TLS to `send.one.com:465`, only for BlackArk's internal alert.
- **Images:** `oven/bun:1.3.14-slim` and `caddy:2.10.2-alpine`. Nothing else is installed: there is no Twilio SDK, and signatures are checked with Bun's built-in crypto.
- **Only one copy per set of lines.** The relay is a single process.

### Environment (`.env`, written by `setup`)

| Variable | Example | Secret |
|---|---|---|
| `RELAY_DOMAIN` | `phone.blackark.uk` | no |
| `PUBLIC_BASE_URL` | `https://phone.blackark.uk` | no; it must be exactly the URL Twilio is given |
| `TWILIO_ACCOUNT_SID` | `AC…` | no |
| `TWILIO_AUTH_TOKEN` | | **yes**: type it at the hidden prompt and never post it |
| `RELAY_LINES_FILE` | `/data/lines.json` (default) | no |
| `PORT` | `8080` (default, behind Caddy) | no |
| `BILLING_URL` | `https://blackark.uk/checkin/phone/` (written by `./deploy.sh billing`) | no |
| `BILLING_SECRET` | | **yes**: the same as `relay_secret` on blackark.uk; typed at a hidden prompt |
| `ALERT_SMTP_HOST`, `ALERT_SMTP_PORT` | `send.one.com`, `465` (written by `./deploy.sh alerts`) | no |
| `ALERT_SMTP_USER`, `ALERT_FROM` | the BlackArk mailbox alerts are sent from | no |
| `ALERT_SMTP_PASSWORD` | | **yes**: that mailbox's password, typed at a hidden prompt |
| `ALERT_TO` | BlackArk's own addresses, comma-separated | no |

### Endpoints

| Who | Endpoint |
|---|---|
| Twilio → relay | `POST /twilio/voice`: the "A call comes in" webhook, HTTP POST |
| Twilio → relay | `POST /twilio/status`: the call status callback |
| Twilio → relay | `POST /twilio/dialed`: where a billed line's forwarded leg reports its minutes (set by the relay itself in the `<Dial>`; nothing to configure in Twilio) |
| Twilio ↔ relay | `wss /twilio/media`: Media Streams, bidirectional, `audio/x-mulaw` 8000 Hz |
| install ↔ relay | `wss /line` with `Authorization: Bearer <line token>` |
| anyone | `GET /health` → `ok` |

## Deploy

```bash
# On the VPS, as a user who can run docker:
git clone --depth 1 https://github.com/amgadbarkat-ab/Ark-Agent.git && cd Ark-Agent/infra/phone-relay
./deploy.sh setup        # asks for the domain, the Account SID and (hidden) the auth token
./deploy.sh add-line demo-shop +30XXXXXXXXXX +30YYYYYYYYYY   # Twilio number, fallback person
#   → prints the line token ONCE: the on-site installer types it into the install's masked field
curl -fsS https://phone.blackark.uk/health   # ok
```

Then, in the Twilio console, for each number:

1. **A call comes in:** Webhook, `https://phone.blackark.uk/twilio/voice`, HTTP POST.
2. **Call status changes:** `https://phone.blackark.uk/twilio/status`.

**Twilio spend cap:** use a prepaid balance with **auto-recharge off**. That is the hard cap. Usage Triggers on top give early warnings.

**Other commands:** `./deploy.sh lines | remove-line <name> | status | logs | restart | update`.

## Test (on any machine with Bun, no Twilio)

```bash
bun test infra/phone-relay/relay.test.ts
```

The test checks that:

- an unsigned webhook, or one for a different account, is refused;
- with no install, the call goes to the fallback number;
- an unknown line token is refused;
- a media socket with a made-up key is closed;
- audio goes both ways;
- the hand-over uses the fallback from `lines.json`, not a number sent by the install;
- no caller number appears in the logs.

## Prepaid phone balance (v0.1.47)

**Which lines:** a line with a `customerId` (`./deploy.sh bill-line <line> <customer-id>`) is paid from that customer's prepaid balance on blackark.uk. See `infra/blackark-checkin/README.md`. **The balance never goes below zero.**

**When a call comes in**, the relay asks blackark.uk for the balance and the rates:
- **If it can't pay a first minute:** the call is not answered (`<Reject reason="busy"/>`). Twilio does not bill a rejected call.
- **If there is no install connected:** that first minute includes the forwarded leg to the fallback number.
- **If blackark.uk can't be reached** (Amgad, 17 Nov):
  1. **ONE call per customer** is answered on the last balance the relay knew. It is still held to that balance minute by minute, so it can never go below it.
  2. **Further calls** hear busy until blackark.uk answers again.
  3. **The cost:** anything that one call costs beyond what is later booked is BlackArk's, never the customer's. blackark.uk writes it off.
  4. **The alert:** BlackArk gets **one internal email** (`./deploy.sh alerts` sets the mailbox and the addresses) when an outage starts.
     - Not again for that outage, and not again for a new outage within the hour.
     - The relay logs when blackark.uk answers again.
     - The email says what is happening, and nothing about any customer or caller.
  5. **No relay mailbox set up:** the alert is only logged.

**During a call:**
- **Shortly before each minute ends** (12 seconds), the relay sets the next minute aside, out of what this customer's other live calls and any unsent charges have not already taken. The next minute is the incoming rate, plus the forwarded leg's rate once the caller is put through.
- **If it can't:**
  1. The install is told (`call.ending`).
  2. The caller hears «Ο διαθέσιμος χρόνος της γραμμής τελείωσε. Παρακαλούμε καλέστε ξανά αργότερα.» ("The line's available time has run out. Please call again later.")
  3. The call ends before the unpaid minute starts.
- **Putting a caller through** sets the forwarded leg's first minute aside first. If that can't be paid, the call ends the same way.

**When a call ends**, the relay reports it:
- **What is sent:** the call id, each part (incoming, or forwarded to a landline or a mobile) and its seconds. **Never the caller's number.**
- **If it fails:** a report blackark.uk did not take is held against the balance and sent again every minute, for a day.
- **The install:** gets the new balance on its line connection, and the app shows it under Settings → Phone line, with **Add 5 hours** in the last hour.

## On Cloudflare Workers (Free plan)

Ordered by Amgad on 19 Nov 2026. **Not deployed:** COO deploys it.

**The address:** `https://blackark-phone.blackark.workers.dev`. The Worker is `blackark-phone`, on account subdomain `blackark`.

**Same as the Bun relay:**
- the same endpoints, TwiML and messages to the install;
- the same prepaid-balance rules, including the v0.1.49 top-up fix;
- the same logic, from `core.ts`.

**What differs is where state lives:**

| Part | Bun (`relay.ts`) | Workers (`worker/`) |
|---|---|---|
| The install's `/line` socket | `Bun.serve`, in memory | one **line** Durable Object per line, socket held with the **Hibernation API** |
| A call's media socket | `wss /twilio/media` | `wss /twilio/media/<line>`: the same line object, Hibernation API. Twilio gets this URL from the relay's TwiML; nothing to configure |
| The one-time media key | memory, 30 s | the line object's SQLite, **SHA-256 only**, 30 s, single use |
| The caller's number | memory, for the 30 s of the key | **not kept at all**: Twilio hands it back in the stream's own `<Parameter>`, and it goes straight to the install |
| Lines (number, token SHA-256, fallback, customer) | `data/lines.json` | the **directory** Durable Object's SQLite, changed with `worker/cli.ts` |
| Set-asides, unsent charges, last balance | memory | the line object's SQLite: survives eviction and restarts |
| Minute timing, retries, 5-minute re-ask | `setTimeout` / `setInterval` | the line object's **alarm**, set to the earliest of these |
| blackark.uk outage, one alert per outage | memory | the directory object (one state for all lines), alerts recorded in SQLite |
| The alert email | `Bun.connect`, TLS, port 465 | `connect()` from `cloudflare:sockets`, `secureTransport: "on"`, port 465 |
| Heartbeat | Bun's own pings | protocol pings are answered by the runtime. `{"type":"ping"}` is auto-answered `{"type":"pong"}` without waking the object (the install sends neither today) |
| Twilio's signature, SHA-256, billing HMAC | `node:crypto` | WebCrypto, checked against `node:crypto` in `core.test.ts` |

**Nothing new is installed in the repository:**
- no `wrangler` and no `@cloudflare/workers-types`;
- `worker/types.ts` declares the few types used;
- `worker/wrangler.toml` is written by hand;
- the bundle is about 43 KB, with no Node built-ins.

### What the Free plan carries

**The limits,** from Cloudflare's pricing and limits pages, read on 19 Nov 2026:

| Limit | Free plan |
|---|---|
| Workers requests | 100,000 a day, 10 ms CPU each |
| Durable Objects requests | 100,000 a day. Incoming WebSocket messages count **20 to 1**; outgoing messages, protocol pings and auto-responses are not counted |
| Durable Objects duration | 13,000 GB-s a day (128 MB per awake object) |
| SQLite | 5 million rows read and 100,000 written a day |

- **Over a limit:** that kind of operation **fails** until 00:00 UTC. That is an outage, not a bill.
- **CPU for an object:** 30 s, reset by each incoming message.

**What one call uses:**

- **Twilio's audio to the relay:** 50 messages a second, sent all through the call (silence included). That is 3,000 a minute, which counts as **150 requests a minute**.
- **The install's audio to the relay:** the speech service's deltas, sent as they come, each a few hundred milliseconds of audio, and only while the employee speaks. That is about 300 a minute (**15 requests**).
  - **Worst case:** the same 50 a second as Twilio (**150 requests a minute**).
- **Other per-minute costs:** the alarm, about 1 request a minute.
- **Once per call:** about 4 Worker requests (the voice webhook, the media socket, the status callback, the forwarded leg's report) and about 8 Durable Object requests.
- **Not requests:** the relay's calls to blackark.uk and to Twilio's API are subrequests.

| Per call-minute | Durable Object requests | How many call-minutes a day Free carries |
|---|---|---|
| Typical (Twilio 50/s, install about 5/s) | about 166 | **about 600 (10 hours)** |
| Worst case (both 50/s) | about 301 | **about 330 (5.5 hours)** |

**So plan on about 300 to 600 call-minutes a day,** roughly 100 to 200 calls of 3 minutes. Durable Object requests are the limit that binds first.

**The other limits come nowhere near:**
- **Workers requests:** about 25,000 calls a day.
- **Duration:** about 1,700 call-minutes. An idle line, with its install connected, hibernates and costs nothing.
- **SQLite writes:** a few per call-minute.

**CPU per message is not a problem.** Measured with the stand-ins (`bun test infra/phone-relay/worker/cpu.test.ts`, Bun's engine, stand-in overhead included): **about 3 µs per media message** each way. That is thousands of times under any limit. On Cloudflare's V8 the figure differs, but not by orders of magnitude.

**One assumption to check after the first test calls:**
- **The assumption:** that the Free plan's 100,000-a-day limit counts WebSocket messages at the same **20 to 1** as the pricing page.
- **If it does not:** each message would count as a request, and Free would carry only **about 30 call-minutes a day**. Workers Paid (USD 5 a month) would then be needed. Paid needs Amgad's yes.
- **How COO checks:** look at the Durable Objects request graph in the dashboard after a few test calls.

### What is different, or only in the Bun relay

- **One billed line per customer on Workers.**
  - **The rule:** `cli.ts bill-line` refuses a second line for a customer who already pays for one.
  - **Why:** each line object holds its own set-asides, so two objects could together spend a balance twice, below zero. The Bun relay shares one balance across a customer's lines.
  - **If it is needed:** a wallet object per customer can be added later.
- **The alert email:**
  - **What is known:** Cloudflare blocks only port 25 for `connect()`, and the board's IMAP already uses the same `connect()` with TLS (port 993).
  - **What is tested:** the SMTP conversation runs against a stand-in mail server.
  - **What is not:** it has not yet been sent from a real Worker.
  - **Either way:** every alert is recorded (`cli.ts alerts` shows the last 20, with "sent", "NOT SENT (why)" or "recorded only").
- **A deploy drops every socket.** Installs reconnect on their own within a second. A call in progress when COO deploys is cut: deploy outside business hours.
- **Changing lines:** a line's changes are seen at the next call; there is no caching. Removing a line closes its install's socket at once.
- **Moving from a VPS:** lines are not copied. Each line gets a new token, and its install needs it typed in again.

### Deploy (COO, after Amgad's yes)

**1. The API token.**
- **Account and scopes:** the same Cloudflare account and the same token scopes as the board: **Workers Scripts: Edit** and **Account Settings: Read**.
  - No D1, R2 or KV is used.
  - Durable Objects need nothing extra on Free: Workers Scripts Edit covers them, and SQLite-backed objects are allowed on Free.
- **Where it lives:** only in COO's own terminal.

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=<the account id; not a secret>
cd infra/phone-relay/worker
W="npx --yes wrangler@4.20.0"   # the same pin as the board
```

**2. The plain settings in `wrangler.toml`.** None of these are secrets.
- `TWILIO_ACCOUNT_SID`: from the Twilio console. It can be set later: until it is, lines can be added and installs connect, and only Twilio's routes (`/twilio/…`) answer 503.
- `ALERT_SMTP_USER`, `ALERT_FROM`, `ALERT_TO`: BlackArk's own mailbox and addresses. Leave them empty and alerts are only recorded.
- `PUBLIC_BASE_URL` is already `https://blackark-phone.blackark.workers.dev`. Twilio signs this exact address.

**3. Deploy, then the secrets.** Each secret is typed at wrangler's hidden prompt. Never put one in a file, a commit or a chat.

```bash
$W deploy
$W secret put TWILIO_AUTH_TOKEN      # Twilio console → Account info → Auth Token
$W secret put RELAY_SECRET           # the same as relay_secret in blackark.uk's checkin/config.php
$W secret put ADMIN_TOKEN            # 32+ random characters (openssl rand -hex 32); keep it in BlackArk's password manager
$W secret put ALERT_SMTP_PASSWORD    # the alert mailbox's password; optional
curl -fsS https://blackark-phone.blackark.workers.dev/health   # ok
```

**4. The lines.** Run from COO's terminal in `infra/phone-relay/worker`.

```bash
read -rs PHONE_ADMIN_TOKEN && export PHONE_ADMIN_TOKEN    # the ADMIN_TOKEN, typed hidden
bun cli.ts add-line demo-shop +30XXXXXXXXXX +30YYYYYYYYYY # Twilio number, fallback person
#   → prints the line token ONCE, on the terminal: the on-site installer types it into the install's masked field
bun cli.ts bill-line demo-shop <customer-id>               # pays its calls from that prepaid balance
bun cli.ts lines | bun cli.ts remove-line <name> | bun cli.ts alerts
```

**5. Twilio console, for each number** (Phone Numbers → the number → Voice configuration):
- **A call comes in:** Webhook, `https://blackark-phone.blackark.workers.dev/twilio/voice`, **HTTP POST**.
- **Call status changes:** `https://blackark-phone.blackark.workers.dev/twilio/status`, **HTTP POST**.

**6. The install:** Settings → Phone line.
- **Relay address:** `https://blackark-phone.blackark.workers.dev`.
- **Line token:** the token from step 4.

**Logs:** `$W tail` shows the relay's own lines live. They carry call ids, line names and durations, never a caller's number. Cloudflare's stored request logs are off (`[observability] enabled = false`), because they would hold Twilio's form fields.

### Test (no Cloudflare, no Twilio)

```bash
bun test infra/phone-relay        # the Bun relay, the shared core, the Workers relay and its CLI
```

**What the Workers tests cover,** over stand-ins for the runtime (`worker/stand-ins.ts`), blackark.uk, Twilio's API and a mail server (`worker/harness.ts`):
- **Webhooks:** a signed and an unsigned webhook, and one for another account.
- **No install:** the call goes to the fallback.
- **Tokens:** an unknown line token.
- **Carrying a call:**
  - audio both ways;
  - the one-time key, which a second stream cannot reuse;
  - the hand-over to the line's own fallback;
  - eviction (hibernation) mid-call;
  - the install dropping mid-call;
  - a newer install replacing an older one;
  - the auto-answered heartbeat.
- **Billing:**
  - busy at zero, and the forwarded leg in the first minute;
  - the balance pushed on every incoming call;
  - a call charged per part (forwarded leg, then incoming);
  - an unanswered call not charged;
  - the next minute set aside, and the cut with the Greek sentence;
  - the 5-minute re-ask by alarm;
  - one call while blackark.uk is down, busy after it, and one alert per outage, sent over the `connect()` stand-in on port 465 with TLS;
  - an unsent charge held and retried;
  - the second billed line refused.
- **Admin:** the admin door, and a removed line's install let go.
- **The CLI:** the token printed once, on stderr only.
- **Logs:** after every test, no log line holds a caller's number.
