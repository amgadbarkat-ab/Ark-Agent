# BlackArk Control Board (#149)

One page for what BlackArk holds centrally about ArkAgent customers:
- the trial check-ins, licences and prepaid phone balances (from blackark.uk);
- support cases, from the app's Help & support and from mail sent to support@blackark.uk;
- Stripe subscriptions, renewals and failed payments, read-only;
- the phone relay's health, and GitHub issues and fixes.

It changes nothing at blackark.uk, Stripe or GitHub; it only reads them. Its own data is staff
accounts, the audit log and support cases. Each person has their own account, with two-factor
sign-in and no password, and everything they do goes into an audit log. It is in English and Greek.

It is **not deployed**. Nothing here is live until Amgad says yes (see [Deploy](#deploy-for-coo-after-amgads-yes)).

It runs as a **Cloudflare Worker on the free plan**, with its data in **D1**. No server, no card.

```
staff browser ── https ──▶ blackark-board.<account>.workers.dev   (a Worker; optionally behind Cloudflare Access)
                              │ fetch: pages read D1 only, never the sources
                              │
                              ├── D1 "blackark-board": accounts, passkeys, sessions, audit log, cases, snapshots
                              │
   Cron Triggers ─────────────┤ every 10 min: the sources, parsed and stored in D1 as snapshots
                              │ every 5 min:  the support mailbox
                              │ nightly:      prune, check the audit chain, copy new audit entries off-site
                              │
     blackark.uk/checkin/export/       ◀── signed POST, signed answer
     blackark.uk/checkin/support/      ──▶ signed POST /intake/app   (Help & support from the app)
     blackark.uk/checkin/audit-copy/   ◀── nightly signed POST of new audit entries (AUDIT_COPY=blackark)
     graph.microsoft.com (General@)    ◀── app-only token; unread mail to support@ only
     api.stripe.com                    ◀── restricted read-only key
     phone relay /health               ◀── GET
     api.github.com                    ◀── read-only token
```

## What it keeps

**In D1** (Cloudflare's SQLite database; the schema is `store.ts`, as a file from `bun cli.ts schema`):
- **Staff accounts:** user name, role, (behind Access) the Access email, the TOTP secret and the last
  TOTP step used. **No password.**
- **Passkeys:** each one's credential id, public key (as a JWK), algorithm and signature counter.
  Never a private key: that stays on the person's phone or computer.
- **Sign-in challenges:** random, single use, 5 minutes.
- **Sessions:** only the SHA-256 of each session's token, with its CSRF token and two times.
- **One-time setup links:** only the SHA-256 of the link, with the TOTP key it offers.
- **Failed sign-ins**, for 15 minutes: the account id, or a keyed hash of the caller's address (HMAC
  with a random salt kept in D1, so it cannot be turned back into the address).
- **The audit log**, append-only, one entry for each:
  - sign-in, refused or not, and sign-out;
  - page of customer data opened;
  - account and case change;
  - refused request (wrong role, missing CSRF token).

  Each entry holds who did it, their role, the action, its target, the result and when.
- **Support cases:** each case's fields, and its internal notes as written, including:
  - what the customer wrote in Help & support, and any diagnostics they chose to send;
  - the sender, subject and text of mail to support@.
- **Snapshots** of the sources, one row each: the last good answer, when it was fetched, and the
  last error. The check-in snapshot holds what blackark.uk's export holds (customer ids, install
  ids, counts, plans, balances); no names or emails.

**What it does not keep:** the caller's IP address; anything else from the customers' own computers.

## What it trusts

| From | Checked by |
|---|---|
| A person, first factor (`FIRST_FACTOR`) | **`passkey`** (the default): a passkey registered to this account signs a single-use challenge (WebAuthn, written here on WebCrypto: ES256 and RS256, the origin and the site's hash checked, user presence required, the signature counter kept). **Or `access`**: Cloudflare Access let the person through, and the email in its signed `Cf-Access-Jwt-Assertion` (RS256 against the team's keys, audience, issuer, expiry) belongs to this account; checked on every request except `/healthz` and `/intake/app`, and a session only holds for the person Access let through. |
| A person, second factor, always | a TOTP code (RFC 6238, our own code), at every sign-in. A code is taken once. |
| A browser | the session cookie `__Host-ark_board`: `Secure; HttpOnly; SameSite=Strict; Path=/`, 15 minutes idle, 8 hours at most |
| A form | the session's CSRF token on every POST, and the browser's `Sec-Fetch-Site`/`Origin` must say it came from the board itself; the sign-in and setup forms use a pre-session token cookie |
| A role | `roles.ts`, on the server, for every page and action (table below) |
| blackark.uk's export | HMAC-SHA256 with `export_secret`, both ways: the request with a time, a nonce taken once and the body; the answer over its time, **our** nonce and the body |
| Help & support from the app | blackark.uk checks the install's BlackArk-signed trial file or licence key, then signs the forward with `intake_secret` (time, nonce taken once, body). The app's request id makes a retry give back the same case. |
| The audit copy at blackark.uk | HMAC-SHA256 with `audit_copy_secret`, both ways, as the export; it keeps only a batch that continues its chain |
| Support mail | only unread mail in General@ whose To or Cc is exactly support@blackark.uk; everything else is never fetched, flagged or moved |
| Stripe | a restricted key that can only read Subscriptions, Checkout Sessions and Invoices |
| The relay | only its public `/health` answer (`ok`) |
| GitHub | a fine-grained token that can only read this repository's issues and PRs |

It holds **no signing key**. Licences are signed only on Amgad's PC.

**Limits on signing in:**
- **One account:** 5 failures in 15 minutes lock it for the rest of the 15 minutes. Every failure
  gets the same answer, so the board never tells which part was wrong.
- **One address:** 20 failures in 15 minutes stop it, across all accounts. The address is Cloudflare's `Cf-Connecting-Ip`.

**Pages:** every page is sent with:
- a strict Content-Security-Policy: scripts and styles only from the board (one script,
  `/webauthn.js`, which asks the browser for the passkey), fonts and images only from the board,
  connections only to the board;
- `X-Frame-Options: DENY` and `Cache-Control: no-store`;
- `noindex`.

Every value on a page is escaped.

**Look:** blackark.uk's (BlackArk Visual Identity v3, Ember): one dark theme, the ember accent, Geist and
Geist Mono, the site's tile as the header logo. The board serves its own copies of the company's files from
`brand/`: the favicons at the site's own paths (`/favicon.ico`, `/favicon-32.png`, `/favicon-192.png`,
`/apple-touch-icon.png`) and the fonts at `/fonts/` (SIL Open Font License, `brand/fonts/LICENSE.txt`).
They are embedded in `brand-assets.ts` by `bun infra/control-board/brand-assets.gen.ts`; run it again after
`brand/` changes (`brand.test.ts` fails until you do). Geist has no Greek, so Greek is set in the system font.

### Roles

| | owner | admin | support | read-only |
|---|---|---|---|---|
| Overview, Customers, Billing, Services, Issues and fixes | yes | yes | yes | yes |
| Cases: read | yes | yes | yes | yes |
| Cases: open, change, add a note | yes | yes | yes | no |
| Audit log | yes | yes | no | no |
| Accounts: add, disable, reset support and read-only | yes | yes | no | no |
| Accounts: add, disable, reset owner and admin | yes | no | no | no |

**Rules for accounts:**
- Nobody can disable or reset their own account.
- The last active owner cannot be disabled or reset.

**A new account** (or a reset one) gets a one-time **setup link**, valid 24 hours and shown once. On it, the person:
- adds the TOTP key to an authenticator app and types the first code;
- with `passkey`, makes a passkey for the board when the browser asks (on a phone, a laptop with a
  fingerprint reader or Windows Hello, or a security key).

There is no QR code: it would need a package. The key and the `otpauth://` link are shown as text.

## Pages

| Page | Shows |
|---|---|
| **Overview** | installs; customers; on trial; paid; trial ends within 7 days; installs silent for 2 days; phone balances low; failed payments (with Stripe); each service up, down or not connected |
| **Customers** | one row per customer id: installs (and how many are silent), version, plan or trial, days left, phone balance, last seen |
| **Customer** | the installs, with the v0.1.49 counts (people, active in 7 days, conversations in 7 days, phone line, system); a timeline of check-ins, trial end, licence changes, phone credits and charges, and cases |
| **Cases** | support cases, open or all; one case with its notes |
| **Billing** | Stripe: failed payments, then every subscription with its state and when it renews or ends |
| **Services** | each source's state, detail and answer time |
| **Issues and fixes** | GitHub issues and PRs, by label, then open / merged / closed |
| **Audit log** | every entry, newest first, and the result of the last nightly chain check |
| **Accounts** | owners and admins add, disable and reset accounts |

Pages show what the last Cron Trigger fetched (at most 10 minutes old). When a source fails, the
page shows the last good data with a warning.

**How a customer's plan is worked out:**
- **Paid:** an active licence, or an install that reports `paid`.
- **On trial:** otherwise, while an install reports a trial with days left.
- **Trial ended:** anything else.

The days left come from the install heard from most recently, because a silent install still reports the days it had then.

## Support cases

**Channels** (Amgad, 18 Nov 2026):
- **in-app Help & support**, the only support channel;
- **email**, for what still arrives at support@blackark.uk.

There is no phone support and no web form.

**Each case has:**
- a number and a customer id;
- a channel and a language (Greek, English);
- the customer's plan (trial or paid) and an urgency (urgent or normal);
- a status and an owner (a board account);
- an SLA due time;
- optionally, a linked GitHub issue;
- internal notes.

**The SLA, in Athens business hours** (Mon–Fri 09:00–18:00; `business-hours.ts`):

| Customer | Urgent | Normal |
|---|---|---|
| trial | end of the next business day | end of the next business day |
| paid | **4 business hours** | end of the next business day |

- **Overdue:** a case still new, open or waiting after its due time is marked overdue.
- **Changes:** changing the urgency or the plan works the due time out again.
- **The plan:**
  - **in-app:** comes signed from blackark.uk, paid while an active licence is on file;
  - **staff-opened:** from the check-ins;
  - **email:** trial, which a person corrects.
- **Public holidays** are days off only when listed (`BOARD_HOLIDAYS` in `wrangler.toml`).

**Notes** are internal: the customer never sees them. A note is never changed or removed. The
audit log records that a note was added, and its length, never its text.

**GitHub:** a case links to an issue by its number. The board shows the link and never writes to GitHub.

### Help & support from the app

1. **The app:** under Settings, then Help & support. The person writes the problem, and can tick "include diagnostics":
   - the app version, the system, and recent warnings and errors, scrubbed on their computer;
   - never conversations, mail, files or keys.

   They see exactly what will be sent before sending.
2. **blackark.uk/checkin/support/:**
   - checks the install's BlackArk-signed trial file or licence key;
   - allows 10 requests per install a day;
   - adds the plan, and forwards the request here, signed with `intake_secret`.
3. **The board** (`/intake/app`, only when `INTAKE_SECRET` is set):
   - opens an in-app case and answers its number;
   - adds the diagnostics as a second note;
   - limits each customer to 20 a day.
4. **If the board cannot be reached:** blackark.uk answers 502, and the app keeps the request and sends it again every hour. The same request id gives back the same case.
5. **Before activation** (Amgad, 23 Nov 2026): the Activate screen has "Need help? Write to BlackArk".
   - The app sends customer `unverified`, the computer's random id, no proof, and an email address only if the person gives one.
   - blackark.uk takes it without proof, at most 3 a day per computer and 3 a day per internet address (a keyed hash, kept 24 hours).
   - The board opens the case as customer `unverified`, shows its plan as **none**, and starts its first note with `UNVERIFIED:` and the contact address. All unverified installs together get at most 50 cases a day.
   - The cases table's plan column takes only `trial` or `paid`, and a running board's table is not rebuilt for this: underneath, such a case is `trial`, which also gives it the normal answer time.

### Support mail

support@blackark.uk is only an alias that delivers to General@blackark.uk. The board reads General@
through **Microsoft Graph** as an Entra app (client credentials: `MS_TENANT_ID`, `MS_CLIENT_ID`,
`MS_CLIENT_SECRET`), never as a person and never with General@'s password (Amgad, 23 Nov 2026).
Every 5 minutes a Cron Trigger (`mail.ts`, `graphMailbox`):
1. gets an app-only token from `login.microsoftonline.com` (one per run, kept nowhere);
2. lists General@'s **unread** Inbox mail from the last 14 days, newest first, asking only for each
   message's id, To and Cc (at most 4 pages of 50);
3. picks the ones whose To or Cc holds support@ exactly, at most 5 a run, and reads only those in full,
   with the body as plain text. A read never marks a message read;
4. checks the To and Cc again on the full message;
5. opens a case, or adds a reply to its case: by In-Reply-To, or `[Case #N]` in the subject. A run
   handles its messages oldest first, so a reply comes after its original;
6. marks **only that message** as read (`PATCH … {"isRead": true}`).

Nothing else in General@ is read in full, flagged, moved, deleted or sent. Attachments are not fetched.
Unread mail to support@ older than 14 days is left for a person.

#### Setting up the Graph app (COO, on Amgad's order)

1. **Entra admin centre → App registrations → New registration:** "BlackArk Control Board", single
   tenant, no redirect URI. Note the *Application (client) ID* (`MS_CLIENT_ID`) and the *Directory
   (tenant) ID* (`MS_TENANT_ID`).
2. **API permissions → Add → Microsoft Graph → Application permissions → `Mail.ReadWrite`**, then
   **Grant admin consent**. Only that one: `Mail.ReadWrite` because marking a message read is a
   write. Not `Mail.Send`: the board sends nothing yet.
3. **Limit the app to General@ before the secret goes on the board.** Without this, an application
   `Mail.ReadWrite` reaches every mailbox in the tenant. In Exchange Online PowerShell:

   ```powershell
   Connect-ExchangeOnline
   # A mail-enabled security group that holds General@ and nothing else.
   New-DistributionGroup -Name "Board mailbox scope" -Alias board-mailbox-scope -Type Security -Members General@blackark.uk
   Set-DistributionGroup -Identity board-mailbox-scope -HiddenFromAddressListsEnabled $true
   New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -PolicyScopeGroupId board-mailbox-scope@blackark.uk `
     -AccessRight RestrictAccess -Description "BlackArk Control Board: General@ only"
   # Check both ways. It can take an hour or more to apply.
   Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -Identity General@blackark.uk     # AccessCheckResult: Granted
   Test-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -Identity <any other mailbox>     # AccessCheckResult: Denied
   ```

   Microsoft now also offers *RBAC for Applications* in Exchange Online for the same limit. The
   policy above is what Amgad asked for; either one is enough, but not neither.
4. **Certificates & secrets → New client secret**, 12 months. Put its *value* straight into
   `$W secret put MS_CLIENT_SECRET` (step 4 of the deploy). Put a reminder in the calendar 2 weeks
   before it expires: when it does, the board's support mail stops (cases from the app keep working).
5. `MAIL_USER` in `wrangler.toml` stays `General@blackark.uk`. With all three secrets set, the next
   5-minute run reads the mail. With any of them unset, the board simply does not read mail.

### Billing (Stripe, read-only)

`stripe.ts` reads with `fetch`, never writes:
- **Subscriptions:** all of them, with their state, when they renew or end, and the amount.
- **Checkout Sessions:** only to map each subscription to the ArkAgent customer id (`client_reference_id`).
- **Open invoices:** with a payment attempt, which are the failed payments.

**Never read:** names, emails, addresses or cards. A subscription with no matching session shows as `stripe-<Stripe customer>`.

## The audit log: append-only, checked, copied

- **Append-only, in code and in the database.** Only `audit.ts` touches the table, and it only
  inserts and reads. The schema also has two triggers, `audit_no_update` and `audit_no_delete`,
  that refuse UPDATE and DELETE. **Both are used.** The triggers are tested on SQLite (the tests'
  stand-in for D1); they have **not been run on a real D1 database from here** (no account). COO
  checks them once after the first deploy (step 9 below).
- **Chained.** Each entry carries the SHA-256 of the one before. Two requests writing at once:
  within one Worker isolate they queue; between isolates each takes the next id explicitly, and the
  loser of the race (on the id, or on the unique `prev_hash`) tries again, so the chain never forks.
- **Checked nightly**, within a cron's 10 ms of CPU: up to 1,000 new entries each night, plus a
  rolling re-check of 500 older ones that starts again from the first entry when it reaches the end.
  A break, once found, stays shown on the Audit log page.
- **Copied off-site nightly** (`AUDIT_COPY`), up to 1,000 new entries a night:
  - **`blackark`** (the default; no card needed): a signed POST to blackark.uk's
    `checkin/audit-copy/`, which recomputes the chain, keeps only a batch that continues it, refuses a
    rewritten entry, and keeps them append-only (its own triggers). See its README.
  - **`r2`**: one JSON object per night in an R2 bucket. R2 needs an R2 subscription with payment
    details on the account, so it is not the default.
  - **`none`**: no copy.

## Run it locally, with made-up data

```bash
bun infra/control-board/dev.ts
```

- It serves http://localhost:8787 on a throwaway SQLite file, and prints a **setup link** for the
  owner `demo`.
- Open it, add the TOTP key to an authenticator app, type the code and make a passkey (browsers allow
  passkeys on `localhost`). Then sign in at http://localhost:8787/login.
- Every source is a stand-in (`standins.ts`, customers `demo-…`, made-up Stripe data), refreshed every
  minute as the Cron Trigger would. Nothing leaves the computer.

## Test

```bash
cd infra/control-board && bun test         # TOTP, passkeys (a virtual authenticator), sign-in, sessions,
                                           # CSRF, roles, audit, chain check and copy, pages, sources,
                                           # CLI, cases, SLA hours, intake, Graph mail, Stripe, Access
bash infra/blackark-checkin/test.sh        # the PHP side: export, Help & support, counts, audit copy
node_modules/.bin/tsc --noEmit -p infra/control-board
```

Run `bun test` from inside the folder: the repository root's `bunfig.toml` preloads the app's test
setup, which the board does not use. The tests use `bun:sqlite` in place of D1 (`sql-sqlite.ts`)
and in-memory stand-ins for Microsoft Graph, Stripe, blackark.uk and the authenticator.

## Deploy (for COO, after Amgad's yes)

**What is needed:** a Cloudflare account on the **Workers Free plan**. No card is needed for the
Worker, D1, Cron Triggers or the `passkey` + `blackark` setup. (Cloudflare Access needs Zero Trust,
and R2 needs an R2 subscription: both ask for payment details even on their free tiers. See
[Limits](#limits-and-the-free-plan).)

**Nothing to install in the repo.** `wrangler` is not a dependency; COO runs it with `npx`, pinned:

```bash
W="npx --yes wrangler@4.20.0"   # COO: check this is still a current 4.x release before the first deploy
```

### 1. The API token (least privilege)

In the Cloudflare dashboard: My Profile → API Tokens → Create Token → Custom token. Give it only:

| Scope | Permission | When |
|---|---|---|
| Account → **Workers Scripts** | Edit | always (deploy, secrets) |
| Account → **D1** | Edit | always (create the database, run the schema and the CLI's SQL) |
| Account → **Account Settings** | Read | always (wrangler reads the account) |
| Account → **Workers R2 Storage** | Edit | only with `AUDIT_COPY = "r2"` |
| Account → **Access: Apps and Policies** | Edit | only if Access is managed by API; not needed when it is set up in the dashboard |
| Zone → **Workers Routes** | Edit | only for a custom domain instead of `workers.dev` (not planned) |

Limit it to BlackArk's account, and give it an expiry. Then, in COO's own terminal only:

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste it; nothing is shown
export CLOUDFLARE_ACCOUNT_ID=<the account id, from the dashboard; not a secret>
```

The token is never written to the repo, a file, or a chat. Revoke it when the deploy is done.

### 2. The database and the schema

```bash
cd infra/control-board
$W d1 create blackark-board                 # copy the database_id it prints into wrangler.toml
bun cli.ts schema > /tmp/board-schema.sql
$W d1 execute blackark-board --remote --file /tmp/board-schema.sql
```

### 3. The settings in `wrangler.toml` (not secrets)

- `BOARD_PUBLIC_ORIGIN`: exactly the address people open, e.g. `https://blackark-board.<subdomain>.workers.dev`.
  Passkeys are tied to this host name: changing it later means everyone makes a new passkey (reset).
- `FIRST_FACTOR`: `passkey` (default). For `access`, also `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`.
- `RELAY_HEALTH_URL`, `BOARD_HOLIDAYS` (e.g. `2026-12-25,2027-01-01,2027-01-06`).
- `AUDIT_COPY` and `AUDIT_COPY_URL`.

### 4. The secrets (Worker secrets, at wrangler's hidden prompt)

Each is typed at `$W secret put <NAME>`, which does not show what is typed. None is ever in the repo,
in `wrangler.toml`, in a commit or in a chat. They live only in the Worker's encrypted secrets
(and, for the shared ones, in blackark.uk's `checkin/config.php`).

| Secret | What it is | Also lives in |
|---|---|---|
| `CHECKIN_EXPORT_SECRET` | 32+ random characters (`php -r 'echo bin2hex(random_bytes(32));'`) | `export_secret` in blackark.uk's `config.php` |
| `INTAKE_SECRET` | 32+ random characters, a different one | `intake_secret` in `config.php` |
| `AUDIT_COPY_SECRET` | 32+ random characters, a different one | `audit_copy_secret` in `config.php` |
| `STRIPE_READ_KEY` | a restricted key (`rk_live_…`): Subscriptions, Checkout Sessions, Invoices, **read** only | Stripe |
| `GITHUB_TOKEN` | fine-grained, this repository only: Issues and Pull requests, **read** only | GitHub |
| `MS_TENANT_ID` | the Entra *Directory (tenant) ID* | Entra ("Setting up the Graph app") |
| `MS_CLIENT_ID` | the board app's *Application (client) ID* | Entra |
| `MS_CLIENT_SECRET` | the board app's client secret *value* (`Mail.ReadWrite`, limited to General@) | Entra |

A secret left unset turns its part off (the page says "not connected"); nothing breaks.

### 5. Deploy

```bash
$W deploy
```

### 6. blackark.uk (upload only with Amgad's yes on that exact build)

- Put the three shared secrets in `checkin/config.php`, and set `intake_url` to `<BOARD_PUBLIC_ORIGIN>/intake/app`.
- Upload `checkin/export/`, `checkin/support/` and `checkin/audit-copy/`.

### 7. The first owner, Amgad himself

```bash
$W d1 execute blackark-board --remote --command "$(bun cli.ts owner <his-user-name>)"
```

- The SQL goes to D1; the **setup link** is printed on the terminal only (stderr), once, valid 24 hours.
- It does nothing if an active owner exists already.
- Amgad opens the link, adds the TOTP key to his phone's authenticator app, types the code and makes
  his passkey. He then adds the others on the **Accounts** page and gives each their link himself.
- With `FIRST_FACTOR = "access"`, add his Access email: `bun cli.ts owner <name> <email>`.

**Other commands**, used the same way: `bun cli.ts reset <user>` (a lost phone or passkey) and
`bun cli.ts unlock <user>`.

### 8. Cloudflare Access (only with `FIRST_FACTOR = "access"`)

- Zero Trust → choose a team name → Access → Applications → Self-hosted, for the board's
  `workers.dev` host name (Access can protect `workers.dev` and preview URLs), allowing only named
  BlackArk staff emails.
- A second application for the path `/intake/app` with a **Bypass** policy: blackark.uk's PHP cannot
  sign in to Access, and that path is signed with its own secret instead.
- Copy the application's AUD tag into `CF_ACCESS_AUD`. Zero Trust asks for payment details even on
  its Free plan (up to 50 users, not charged).

### 9. Check

- `https://<board>/healthz` answers `ok`.
- Sign in, and look at **Services** after 10 minutes.
- The audit log's triggers, once:
  ```bash
  $W d1 execute blackark-board --remote --command "UPDATE audit SET outcome = outcome WHERE id = 1"
  ```
  must fail with "append-only". If it does not, tell PE: the code-side protection still holds, but
  the database-side one is missing.

## What Amgad must provide, or say yes to

- **Builds:** a yes on this build and on the blackark.uk upload (`checkin/export/`, `checkin/support/`, `checkin/audit-copy/`).
- **Cloudflare:** a yes on the account (Workers Free plan), the API token's scopes, and the
  `workers.dev` address.
- **First factor:** `passkey` (no card) or `access` (Zero Trust, payment details on file).
- **Audit copy:** `blackark` (no card) or `r2` (an R2 subscription, payment details on file).
- **The first owner account:** his own, with his phone's authenticator app and a passkey.
- **The Greek public holidays** to list, or a yes to keep only weekends.

COO makes the shared secrets, the Stripe and GitHub read-only keys, and the Graph app's three
entries (after the ApplicationAccessPolicy), all at hidden prompts.

## Limits and the free plan

The Workers Free plan gives 100,000 requests a day, **10 ms of CPU** per request and per cron run,
50 subrequests and 50 D1 queries per invocation; D1 Free gives 5 GB. The board is built to that:

- **Pages read D1 only.** Every outside call is made by a Cron Trigger and parsed there.
- **No passwords:** a password hash that resists guessing (argon2id) needs far more than 10 ms.
- **What could reach 10 ms of CPU as BlackArk grows** (fine at today's size; to measure in
  production with `wrangler tail`):
  - the check-in export, parsed in the cron and again (as stored JSON) on the Overview and Customers
    pages: about a thousand installs is where to look again;
  - the nightly chain check and copy, bounded to 1,000 new entries a night. Every page of customer
    data opened is an entry, so more than about 1,000 entries a day would make the copy fall behind;
    the fix is to run the copy more often, from the 10-minute cron;
  - the support mail, in the 5-minute cron: Graph does the parsing, and the board reads at most 5
    messages a run, as plain text.
- **Cloudflare may stop a run that goes over** the CPU limit; the next run tries again, and a source
  keeps its last good data.
- **Paid or card-on-file:** Cloudflare Access (Zero Trust) and R2 ask for payment details. Neither is
  needed with `passkey` and `blackark`.
- **The TOTP secrets** are stored as they are, because the board must read them to check a code. A
  copy of the database alone does not sign anyone in: the passkey (or Access) is needed too.
- **Someone with the Cloudflare account** can still change D1 directly. The chain check shows a
  changed entry; the copy at blackark.uk keeps what was there before.
