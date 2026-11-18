# 05 Case intake: app form endpoint and mailbox poller (design)

Status: resolved
Type: task

Design in `../intake-design.md`. Built and tested against stand-ins: `POST /intake/app` (HMAC,
nonce once, 20/day/customer), `pollMailbox` with `MailSource` and `standInMailbox`. Not switched
on: needs a decision on who signs app requests (proposal: blackark.uk after checking the install's
signed profile), the support mailbox, and Amgad's yes. Tests: `intake.test.ts`.
