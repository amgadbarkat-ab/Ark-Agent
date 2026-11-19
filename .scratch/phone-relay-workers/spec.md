# Phone relay on Cloudflare Workers + Durable Objects

Status: resolved (pending review and deploy) (sub-agent I, for PE; ordered by Amgad 19 Nov 12:21 Athens, top priority)
Toolkit: Matt Pocock's skills (`/tdd`). Branch `claude/phone-relay-workers` from
`origin/claude/phone-e2e-149` (`ac57583`: v0.1.49 plus the relay-only top-up fix).

## Goal

The same relay as `infra/phone-relay/relay.ts` (Bun, Docker), on Workers Free: COO deploys it with
wrangler and points the Twilio number at `https://blackark-phone.blackark.workers.dev`. The Bun relay
stays, with its tests passing. Logic is shared (`infra/phone-relay/core.ts`), and the platform parts
are thin (`infra/phone-relay/worker/`).

## Seams under test (the list PE gave; tests go only here)

1. **The Worker's `fetch(request, env)`**: Twilio webhooks (signed, unsigned, wrong account), `/line`
   upgrades (known or unknown token), `/twilio/media/<line>` upgrades, `/admin/*`.
2. **The two socket ends a client holds** (install, Twilio media): what each receives.
3. **Stand-in outside services**: blackark.uk (keeps the balance, checks the HMAC), Twilio's REST API
   (records hand-overs and hang-ups), an SMTP server (the alert).
4. **Time**: the line object's alarm, fired by the stand-in runtime as Workers would.
5. **Logs**: every line the relay writes, for the caller's number.
6. **`runCli(args, io, fetch)`**: the line admin CLI.

Not tested through internals: no SQL is read by tests.

## Decisions

- One Durable Object per line (`LINE`, named by the line's name): the install socket, the calls'
  media sockets (Hibernation API), meters, unsent charges, last balance (SQLite).
- One directory object (`DIRECTORY`): lines (name, number, token SHA-256, fallback, customer), and
  the blackark.uk outage state, so the alert goes once per outage for the whole relay, not per line.
- **One billed line per customer** on Workers (the CLI refuses a second). Reason: the balance must
  never go below zero, and two line objects cannot share set-asides without a third object in every
  minute. The Bun relay still allows several. Follow-up if wanted: a wallet object per customer.
- The caller's number goes to the media socket as a second `<Parameter>`, so the relay stores no
  caller number anywhere, not even for the 30 s of the media key. The key itself is stored as SHA-256.
- Admin: `POST /admin/*` with `Authorization: Bearer <ADMIN_TOKEN>` (a Worker secret). The CLI makes
  the line token locally and sends only its SHA-256.
- Webhooks await their billing call (3 s timeout) instead of answering first: deterministic on Workers.
- Alert email: Workers `connect()` blocks only port 25 (Cloudflare docs, read 19 Nov), and the board's
  IMAP uses the same `connect()` with TLS, so `smtp.ts` was ported: its conversation now runs over web
  streams for both relays. Not yet sent from a real Worker; every alert is recorded either way.
- Unsent charges retried at most 40 per alarm (50 subrequests per invocation).

## Free-plan estimate (README "What the Free plan carries")

Durable Object requests bind first: about 166 per call-minute typical (Twilio's 50 msg/s at 20:1, the
install's speech deltas, one alarm), about 301 worst case, so about 600 or 330 call-minutes a day.
Assumes the Free daily limit counts WebSocket messages 20:1 as the pricing page does; if not, about
30 call-minutes a day. CPU: about 3 µs per media message (stand-ins, Bun), DO CPU limit 30 s per message.

## Comments

- 19 Nov: core extracted (`df3a169`), Bun relay unchanged in behaviour, e2e green.
- 19 Nov: Worker, line and directory objects, CLI, wrangler.toml, README section. 56 relay tests
  pass (27 Workers), the phone add-on e2e test passes. Mutation checks: removing the balance push,
  the minute set-aside or the one-call-while-down rule each fails its test.
- Open: whether to allow several billed lines per customer (wallet object); a `cli.ts import` from a
  VPS `lines.json` if a VPS relay is already live (tokens would carry over).
