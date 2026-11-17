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

**Which lines:** a line with a `customerId` (`./deploy.sh bill-line <line> <customer-id>`) is paid from that customer's prepaid balance on blackark.uk. See `infra/blackark-checkin/README.md`.

**Before a call is answered**, the relay asks blackark.uk for the balance:

| Balance | What happens |
|---|---|
| used up (`empty`) | the caller goes straight to the line's fallback number |
| past the debt cap (`blocked`) | the caller hears that number and the call ends |
| anything else | the employee answers as usual |
| blackark.uk unreachable | the employee answers as usual |

**When a call ends**, the relay reports it:
- **What is sent:** the call id, each part (incoming, or forwarded to a landline or a mobile) and its seconds. **Never the caller's number.**
- **If it fails:** a report blackark.uk did not take is sent again every minute, for a day.
- **The install:** gets the new balance on its line connection, and the app shows it under Settings → Phone line, with **Add 5 hours** in the last hour.

