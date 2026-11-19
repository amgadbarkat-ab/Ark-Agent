# v0.1.49, sub-agent H: activation after payment, Save As, phone add-on end to end

Ordered by Amgad, 19 Nov 2026 06:31 Athens. Worked by sub-agent H for PE on `claude/v0149-activation`
(from `origin/claude/control-board-149` at `daf9cd0`), with Matt Pocock's skills (`/tdd`,
`/diagnosing-bugs`). Every change starts with a failing test.

## Seams under test

Taken from the brief (PE could not be asked separately from inside this run):

- `checkin/renew/` over HTTP, on PHP's built-in server (`infra/blackark-checkin/test.sh`). Catches a key
  handed out without proof, for the wrong customer, past the rate limit. Misses one.com's own PHP.
- The activation service (`server/src/trial/activation.ts`) with a stand-in fetch: what is sent, when
  it asks, and that a fetched key is applied exactly as a typed one. Misses the real network.
- End to end: a signed stand-in Stripe event to the real `stripe/`, the real `renew/`, and the
  server's activation service. Misses Stripe itself.
- Rust: `downloads.rs` pure helpers (name, folder, what happens on cancel) and the capability built
  for the app's own origin. Misses the native dialog itself (needs a display).
- Phone: the real relay (`infra/phone-relay/relay.ts`), the real PHP `phone/`, `buy/`, `stripe/`, and the
  server's phone-line connection, with stand-ins for Twilio and Stripe.

## Coordination with G (Stripe tiers)

- Licence format and `stripe/index.php` price handling untouched. Keys pass through as opaque `ARK1-`.

## Notes

(filled in as the work goes)
