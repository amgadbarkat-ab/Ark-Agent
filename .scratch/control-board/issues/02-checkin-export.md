# 02 Signed read-only export on the check-in service

Status: resolved
Type: task

`infra/blackark-checkin/checkin/export/index.php`: POST, HMAC-SHA256 over `<time>.<nonce>.<body>`
with a new `export_secret` (separate from `relay_secret`), 5-minute window, nonce taken once
(`export_nonces`, pruned after 15 min), answer signed over `<time>.<request nonce>.<answer>`.
Returns installs, licences (no key, no Stripe ids), phone balances with state, 90 days of ledger
(no refs). Nothing personal.

Tests: 9 new checks in `infra/blackark-checkin/test.sh` (GET, unsigned, other body, other secret,
stale, good + answer signature, content, no personal data, replay) plus the board's own TS client
against the PHP server.
