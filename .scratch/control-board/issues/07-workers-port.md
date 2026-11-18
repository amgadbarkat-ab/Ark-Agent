# 07 Port to Cloudflare Workers + D1 (free plan, no card)

Status: resolved (not deployed)
Type: task

PE's instructions of 18 Nov 2026 (hosting moved from the Oracle VM to Workers + D1). Matt Pocock's
skills (tdd), not Spec Kit.

- **Common to every mode**
  - worker.ts: `fetch` and `scheduled`; wrangler.toml and our own type files; no wrangler dependency.
  - sql.ts (D1 adapter) behind one interface; sql-sqlite.ts (`bun:sqlite`) for tests and dev.ts.
  - Cron Triggers: sources every 10 min, mailbox every 5, nightly prune + chain check + audit copy.
    Pages read snapshots only.
  - imap.ts: our own IMAP client over `connect()` (port 993, TLS) and a small MIME parser.
  - Append-only audit log: both code and SQLite/D1 triggers (triggers not run on real D1 yet).
  - VM files removed (Dockerfile, compose.yaml, deploy.sh, server.ts, mail-deps.ts, board.css).
- **First factor** (`FIRST_FACTOR`): `passkey` (WebAuthn on WebCrypto, no package) or `access`.
  TOTP always second. No passwords.
- **Audit copy** (`AUDIT_COPY`): `blackark` (checkin/audit-copy/, HMAC both ways, append-only,
  chain recomputed in PHP) or `r2`.
- **Bounded for 10 ms of CPU:** nightly chain check 1,000 new + 500 rolling older; copy 1,000 a night.
- **Address key** for the sign-in limit: HMAC with a random salt in D1, not a plain hash.
- **Left out (PE):** a link from `/activate` to Help & support (customer-facing; PE asks).

## Open

- The pinned wrangler version in README (4.20.0) for COO to confirm before the first deploy.
- More than ~1,000 audit entries a day would make the nightly copy lag: move the copy to the
  10-minute cron if that happens.
- Questions 3 and 4 are with Amgad.
