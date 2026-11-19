# Phone relay on Cloudflare Workers + Durable Objects

Status: claimed (sub-agent I, for PE; ordered by Amgad 19 Nov 12:21 Athens, top priority)
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
