# 06 Milestone 3: Help & support, General@ intake, Stripe, counts, Cloudflare

Status: resolved
Type: task

Amgad's decisions of 18 Nov 2026 (06:26 and 06:40 Athens), relayed by PE.

- **In-app Help & support**
  - Desktop: Settings, then Help & support (app/src/routes/_authed/settings/help.tsx, server/src/support/).
  - Optional diagnostics: version, system, and recent warnings and errors, scrubbed when caught.
  - The exact payload is shown before sending, and exactly that payload is sent.
  - The case number comes back. A queued request is sent again hourly with the same id.
- **blackark.uk/checkin/support/**
  - Checks the signed trial profile, code or licence for the customer, and limits each install to 10 a day.
  - Adds the plan, and forwards to the board signed with `intake_secret`.
- **Board**
  - SLA in Athens business hours by plan (business-hours.ts).
  - Channels in-app and email; urgency urgent or normal; plan per case.
- **General@ over IMAP** (mail.ts)
  - Only unread mail To or Cc support@ is fetched, with PEEK, and checked exactly.
  - Only what is taken is marked read.
  - imapflow and mailparser come from the server workspace, at the root bun.lock's versions.
- **Stripe** (stripe.ts): read-only, with fetch.
  - Subscriptions, Checkout Sessions (for our customer id) and open invoices (failed payments).
  - A Billing page and a Failed payments tile.
- **Counts-only check-in** (server/src/trial/counts.ts)
  - people, active in 7 days, conversations in 7 days, phone line, os.
  - Accepted by checkin/index.php and the server receiver, exported, and shown on the board.
- **Privacy notice:** updated in docs/legal/privacy-notice.md.
- **Hosting:** Oracle Always Free VM, behind Cloudflare Tunnel and Access (superseded: see 07, Workers + D1).
  - The Cf-Access-Jwt-Assertion check (access.ts) is off until configured.

## Comments

- The Docker image was not built here (no Docker daemon). Each step was run by hand.
- A computer whose trial has ended is held on /activate, so it cannot open Help & support. Asked PE
  whether /activate should link to it.
