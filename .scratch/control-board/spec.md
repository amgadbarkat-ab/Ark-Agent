# ArkAgent Control Board (#149)

Status: open
Toolkit: Matt Pocock's skills (`/tdd`), not Spec Kit.
Branch: `claude/control-board-149`

## Problem

BlackArk runs ArkAgent for customers whose data stays on their own computers. What BlackArk holds
centrally is spread over four places: the trial check-ins and the phone balance on blackark.uk
(one.com, PHP), the phone relay on the EU VPS, Stripe, and GitHub issues. Today the only view is the
check-in status page behind one shared password. The MD's brief (18 Nov 2026, #149) asks for one
board with individual accounts, 2FA and an audit trail.

## Milestone 1: a read-only board

- `infra/control-board/`: one Bun process (no packages beyond the repo's own), server-rendered HTML,
  English and Greek, behind Caddy on the same EU VPS as the phone relay. SQLite (`bun:sqlite`) for
  accounts, sessions and the audit log.
- Access: individual accounts; password (argon2id, `Bun.password`) and TOTP (RFC 6238, our own
  code) at every sign-in; roles owner, admin, support, read-only; sessions of 15 minutes idle and
  8 hours at most in `__Host-` cookies (Secure, HttpOnly, SameSite=Strict); a CSRF token on every
  form; sign-in limits per account and per address; an append-only, hash-chained audit log of every
  sign-in and every action; `bun cli.ts create-owner` at a hidden prompt.
- Data, each behind an interface with a stand-in in tests:
  - check-ins, licences and phone balances: a new signed, read-only export on the check-in service
    (`checkin/export/`), HMAC-SHA256 with `export_secret`, a timestamp, a nonce taken once, and a
    signed answer. No IP, no name, no email, no key.
  - the relay's `GET /health`;
  - GitHub issues and PRs (a token only later);
  - Stripe (a restricted read-only key only later).
- Pages: Overview, Customers, Customer (timeline), Services, Issues and fixes, Audit log, Accounts.

## Milestone 2: support cases

Cases (number, customer id, channel, language, priority, status, owner, internal notes, SLA due),
linked to a GitHub issue. Intake designed only: a signed endpoint for the app's future "Help &
support" form, and an IMAP poller with a stand-in. See `intake-design.md`.

## Seams under test (proposed by sub-agent A; PE to confirm)

The skill asks for the seams to be agreed before tests. There was no one to ask inside this run, so
these were chosen and are listed here for PE to confirm or move:

| Seam | Catches | Misses |
|---|---|---|
| `totp.ts` (`totp`, `verifyTotp`, base32) against the RFC 6238 vectors | wrong HMAC, counter, truncation, window | clock drift on the real server |
| `createBoard(...).fetch(Request)`: the whole board as HTTP, with a fake clock and stand-in sources | sign-in, 2FA, lockout, cookies, CSRF, roles, audit entries, every page's content, escaping, Greek | Caddy, TLS, the browser's own cookie handling |
| `audit.ts` against a real SQLite file | that the log cannot be edited or deleted, and that the chain shows tampering | someone with root replacing the whole file |
| `checkinExport(...)` against a Bun stand-in server | request signing, refusing an unsigned or replayed answer | PHP's side, which `test.sh` covers |
| `checkin/export/` in `infra/blackark-checkin/test.sh`, PHP on its built-in server | good, bad, stale and replayed signatures; that nothing personal is in the answer; the board's own client reading it | one.com's Apache |
