# 03 Pages: Overview, Customers, Customer, Services, Issues and fixes, Audit log, Accounts

Status: resolved
Type: task

Server-rendered, escaped by default (`html.ts`), English and Greek (`i18n.ts`), no scripts, CSP
`default-src 'none'`. Sources behind interfaces (`sources.ts`) with stand-ins (`standins.ts`), each
asked at most once a minute, last good answer shown with a warning when a source fails.

Tests: `pages.test.ts`, `sources.test.ts`, `i18n.test.ts` (fails when a phrase has no Greek).

## Comments

- Plan per customer: paid (active licence or a `paid` install) > trial (a trial install with days
  left) > ended. Days left from the most recently heard install.
