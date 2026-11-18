# 01 Access: accounts, TOTP, roles, sessions, CSRF, limits, audit log, CLI

Status: resolved
Type: task

Individual accounts with argon2id passwords and mandatory TOTP (RFC 6238 on node:crypto); roles
owner/admin/support/read-only; `__Host-` session cookie, 15 min idle / 8 h max; CSRF token on every
form plus Sec-Fetch-Site/Origin; 5 failures per name and 20 per address in 15 min; append-only,
hash-chained audit log; `cli.ts create-owner` at a hidden prompt; one-time setup links.

Tests: `totp.test.ts`, `auth.test.ts`, `audit.test.ts`, `cli.test.ts`.

## Comments

- No IP is written anywhere, including the audit log. Open question for PE: does Amgad want a
  coarse network (e.g. /24) on sign-in entries for security review?
