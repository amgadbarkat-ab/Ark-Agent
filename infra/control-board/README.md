# BlackArk Control Board (#149)

One page for what BlackArk holds centrally about ArkAgent customers:
- the trial check-ins, licences and prepaid phone balances (from blackark.uk);
- support cases, from the app's Help & support and from mail sent to support@blackark.uk;
- Stripe subscriptions, renewals and failed payments, read-only;
- the phone relay's health, and GitHub issues and fixes.

It changes nothing at blackark.uk, Stripe or GitHub; it only reads them. Its own data is staff
accounts, the audit log and support cases. Each person has their own account, with two-factor
sign-in, and everything they do goes into an audit log. It is in English and Greek.

It is **not deployed**. Nothing here is live until Amgad says yes (see [Deploy](#deploy-for-coo-after-amgads-yes)).

```
staff browser ── https ──▶ Cloudflare Access (who may reach it) ──▶ Cloudflare Tunnel
                                                                        │ (outbound from the VM)
   Oracle Always Free VM, EU region, Docker:   cloudflared ──▶ board:8080 (Bun, this folder; no public port)
                                                                        │
     blackark.uk/checkin/export/   ◀── signed POST, signed answer ──────┤
     blackark.uk/checkin/support/  ──▶ signed POST /intake/app ─────────┤ (Help & support from the app)
     General@blackark.uk (IMAP)    ◀── unread mail to support@ only ────┤
     api.stripe.com                ◀── restricted read-only key ────────┤
     phone.blackark.uk/health      ◀── GET ─────────────────────────────┤
     api.github.com                ◀── read-only token ─────────────────┘
```

## What it keeps

**In its own SQLite file** (`data/board.sqlite`, on the VM only):
- **Staff accounts:**
  - user name and role;
  - the password as an **argon2id** hash;
  - the TOTP secret;
  - the last TOTP step used.
- **Sessions:** only the SHA-256 of each session's token, with its CSRF token and two times.
- **One-time setup links:** only the SHA-256 of the link.
- **Failed sign-ins:** the user name and the time, for 15 minutes.
- **The audit log**, append-only, one entry for each:
  - sign-in, refused or not, and sign-out;
  - page of customer data opened;
  - account and case change;
  - refused request (wrong role, missing CSRF token).

  Each entry holds who did it, their role, the action, its target, the result and when.
- **Support cases:** each case's fields, and its internal notes as written, including:
  - what the customer wrote in Help & support, and any diagnostics they chose to send;
  - the sender, subject and text of mail to support@.

**What it does not keep:**
- **Data from the sources** (check-ins, Stripe, GitHub): it is asked for at most once a minute and held in memory only.
- **IP addresses:** the caller's address is held in memory for 15 minutes, for the sign-in limit, and never written down.
- Anything else from the customers' own computers.

## What it trusts

| From | Checked by |
|---|---|
| Who may reach it at all | **Cloudflare Access** in front of the tunnel. With `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` set, the board also checks Access's signed `Cf-Access-Jwt-Assertion` on every request (RS256 against the team's keys, audience, issuer, expiry; `node:crypto`), so a request that reached it around the tunnel gets nothing. Not checked: `/healthz` (Docker's own check) and `/intake/app` (signed with its own secret). |
| A person | user name, password (argon2id) **and** a TOTP code (RFC 6238, our own code on Bun's crypto), at every sign-in. A code is taken once. |
| A browser | the session cookie `__Host-ark_board`: `Secure; HttpOnly; SameSite=Strict; Path=/`, 15 minutes idle, 8 hours at most |
| A form | the session's CSRF token on every POST, and the browser's `Sec-Fetch-Site`/`Origin` must say it came from the board itself; the sign-in and setup forms use a pre-session token cookie |
| A role | `roles.ts`, on the server, for every page and action (table below) |
| blackark.uk's export | HMAC-SHA256 with `export_secret`, both ways: the request with a time, a nonce taken once and the body; the answer over its time, **our** nonce and the body |
| Help & support from the app | blackark.uk checks the install's BlackArk-signed trial file or licence key, then signs the forward with `intake_secret` (time, nonce taken once, body). The app's request id makes a retry give back the same case. |
| Support mail | only unread mail in General@ whose To or Cc is exactly support@blackark.uk; everything else is never fetched, flagged or moved |
| Stripe | a restricted key that can only read Subscriptions, Checkout Sessions and Invoices |
| The relay | only its public `/health` answer (`ok`) |
| GitHub | a fine-grained token that can only read this repository's issues and PRs |

It holds **no signing key**. Licences are signed only on Amgad's PC.

**Limits on signing in:**
- **One name:** 5 failures in 15 minutes lock that name for the rest of the 15 minutes, even with the right password and code. Unknown names are counted the same way, and every failure gets the same answer, so the board never tells which names exist.
- **One address:** 20 failures in 15 minutes stop it, across all names. The address is Cloudflare's `Cf-Connecting-Ip`.

**Pages:** every page is sent with:
- a strict Content-Security-Policy (no scripts at all, styles only from the board);
- `X-Frame-Options: DENY` and `Cache-Control: no-store`;
- `noindex`.

Every value on a page is escaped.

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

**A new account** gets a one-time **setup link**, valid 24 hours and shown once. On it, the person:
- chooses a password of at least 12 characters;
- adds the TOTP key to an authenticator app;
- types the first code.

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
| **Audit log** | every entry, newest first, and whether the chain of entries is intact |
| **Accounts** | owners and admins add, disable and reset accounts |

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
- **Public holidays** are days off only when listed (`./deploy.sh holidays`).

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

### Support mail

support@blackark.uk is only an alias that delivers to General@blackark.uk. Every 2 minutes the board:
1. signs in to General@ over IMAP (TLS, port 993);
2. asks for **unread** messages To or Cc support@ only;
3. reads each with `BODY.PEEK`, so nothing is marked read by reading it;
4. checks the parsed To and Cc again, exactly;
5. opens a case, or adds a reply to its case: by In-Reply-To, or `[Case #N]` in the subject;
6. marks **only that message** as read.

Nothing else in General@ is fetched, flagged, moved or deleted. Attachments are not kept.

`imapflow` and `mailparser` are the server workspace's own, at the versions in the root `bun.lock`;
no package is added. The image carries only them and what they need (`mail-deps.ts`, about 15 MB).

### Billing (Stripe, read-only)

`stripe.ts` reads with `fetch`, never writes:
- **Subscriptions:** all of them, with their state, when they renew or end, and the amount.
- **Checkout Sessions:** only to map each subscription to the ArkAgent customer id (`client_reference_id`).
- **Open invoices:** with a payment attempt, which are the failed payments.

**Never read:** names, emails, addresses or cards. A subscription with no matching session shows as `stripe-<Stripe customer>`.

## Run it locally, with made-up data

```bash
bun infra/control-board/dev.ts
```

It prints the sign-in details and the current TOTP code every 30 seconds:
- **Address:** http://localhost:8787/login
- **User name:** `demo`
- **Password:** `demo-password-1`

Every source is a stand-in (`standins.ts`, customers `demo-…`, made-up Stripe data). Nothing leaves the computer.

## Test

```bash
cd infra/control-board && bun test         # the board: TOTP, sign-in, sessions, CSRF, roles, audit, pages, sources,
                                           # CLI, cases, SLA hours, intake, IMAP filter, Stripe, Access
bash infra/blackark-checkin/test.sh        # the PHP side: export, Help & support forward, check-in counts
node_modules/.bin/tsc --noEmit -p infra/control-board
```

Run `bun test` from inside the folder: the repository root's `bunfig.toml` preloads the app's test
setup, which the board does not use.

## Deploy (for COO, after Amgad's yes)

**Where:** BlackArk's Oracle Always Free VM in an EU region, beside the phone relay and Ark Link, in
Docker. The board **publishes no port**. `cloudflared` (Cloudflare Tunnel) dials out to Cloudflare
and carries requests to `board:8080` on the compose network. Cloudflare Access decides who may
reach it. The board's own accounts and TOTP apply on top.

### What COO sets up in Cloudflare first (no account exists yet)

1. **A Cloudflare account** for BlackArk (the Free plan covers Tunnel, and Access for up to 50 users).
2. **The blackark.uk zone.**
   - Either move blackark.uk's DNS to Cloudflare, or use a subdomain that Cloudflare manages.
   - Check that one.com's site and mail records are copied over first, so nothing else breaks.
3. **Zero Trust:**
   - choose a **team name**, which gives `<team>.cloudflareaccess.com`;
   - set a sign-in method for Access, for example one-time PIN by email, for BlackArk staff addresses only.
4. **A Tunnel**, under Networks, then Tunnels, then Create, then Cloudflared:
   - name it `blackark-board`;
   - copy its **token**. It is a secret: type it at `./deploy.sh tunnel` and never post it.
   - Add a **public hostname** `board.blackark.uk` with the service **HTTP** `board:8080`.
5. **An Access application**, self-hosted, for `board.blackark.uk`:
   - a policy that allows only BlackArk staff (named emails);
   - copy the application's **Application Audience (AUD) tag**, for `./deploy.sh access`. It is not a secret.
6. **A second Access application** for `board.blackark.uk/intake/app`, with a **Bypass** policy.
   - blackark.uk's PHP cannot sign in to Access.
   - That one path is protected by its own HMAC signature instead.

### On the VM

1. **Amgad says yes** to this build, the DNS name and the Cloudflare setup.
2. **Build:**
   ```bash
   cd Ark-Agent && git pull && cd infra/control-board
   ./deploy.sh setup        # the board's address; writes .env; builds the image
   ```
3. **Start and protect:**
   ```bash
   ./deploy.sh tunnel       # the tunnel token (hidden); starts board + cloudflared
   ./deploy.sh access       # team domain and AUD tag: requests around the tunnel are refused from now on
   ```
4. **blackark.uk** (upload only with Amgad's yes on that exact build):
   - make two secrets with `php -r 'echo bin2hex(random_bytes(32));'`;
   - put them in `export_secret` and `intake_secret` in `checkin/config.php`, and set `intake_url` to `https://board.blackark.uk/intake/app`;
   - upload `checkin/export/` and `checkin/support/`. Then:
   ```bash
   ./deploy.sh checkin      # the export secret (hidden)
   ./deploy.sh intake       # the Help & support secret (hidden)
   ```
5. **The first owner**, Amgad himself, at the VM's terminal:
   ```bash
   ./deploy.sh owner        # user name; password twice at a hidden prompt; adds the TOTP key; first code
   ```
   Amgad then adds the others on the **Accounts** page, and gives each their setup link himself.
6. **Read-only keys (COO makes them; they never go into the repo or a chat):**
   ```bash
   ./deploy.sh stripe       # a restricted key: Subscriptions, Checkout Sessions and Invoices, read only
   ./deploy.sh github       # a fine-grained token: Issues and Pull requests, read only, this repository
   ./deploy.sh mailbox      # General@'s IMAP sign-in (imap.one.com:993); only mail to support@ is read
   ./deploy.sh holidays     # Greek public holidays, e.g. 2026-12-25,2027-01-01,2027-01-06
   ```
7. **Check:**
   - run `./deploy.sh status`, which should answer `ok`;
   - then, through Access, sign in at `https://board.blackark.uk/` and look at **Services**.

**Other commands:** `./deploy.sh reset <user> | unlock <user> | accounts | verify-audit | logs | restart | update`.

### Environment

`.env` and `tunnel.env` are both mode 600 and written by `deploy.sh`.

| Variable | Example | Secret |
|---|---|---|
| `BOARD_PUBLIC_ORIGIN` | `https://board.blackark.uk` | no; exactly the address people open |
| `TUNNEL_TOKEN` (in `tunnel.env`, cloudflared only) | | **yes** |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | `blackark.cloudflareaccess.com`, the AUD tag | no |
| `CHECKIN_EXPORT_URL`, `CHECKIN_EXPORT_SECRET` | `https://blackark.uk/checkin/export/` | the secret **yes** |
| `INTAKE_SECRET` | | **yes**: the same as `intake_secret` on blackark.uk. Unset: no `/intake/app` |
| `STRIPE_READ_KEY` | `rk_live_…`, restricted, read-only | **yes** |
| `GITHUB_REPO`, `GITHUB_TOKEN` | `amgadbarkat-ab/Ark-Agent` | the token **yes** |
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT`, `MAIL_USER`, `MAIL_PASSWORD` | `imap.one.com`, `993`, `General@blackark.uk` | the password **yes** |
| `SUPPORT_ADDRESS` | `support@blackark.uk` | no |
| `BOARD_HOLIDAYS` | `2026-12-25,2027-01-01` | no |
| `RELAY_HEALTH_URL` | `https://phone.blackark.uk/health` | no |
| `PORT`, `BOARD_DATA_DIR`, `TRUST_PROXY` | `8080`, `/data`, `1` (set in the image) | no |

**Images:**
- `oven/bun:1.3.14-slim`, the same as the relay;
- `cloudflare/cloudflared:2025.8.0`. COO checks the current tag before the first deploy.

**Outbound only:**
- Cloudflare, for the tunnel;
- HTTPS to `blackark.uk`, `api.stripe.com`, `api.github.com` and `phone.blackark.uk`;
- IMAPS to `imap.one.com:993`.

## What Amgad must provide, or say yes to

- **Builds:** a yes on this build and on the blackark.uk upload (`checkin/export/`, `checkin/support/`).
- **Cloudflare:** a yes on the account, the DNS change for blackark.uk, and `board.blackark.uk`.
- **The first owner account:** his own, at the VM terminal, with his phone's authenticator app.
- **The Greek public holidays** to list, or a yes to keep only weekends.

COO makes the export and intake secrets, the Stripe and GitHub read-only keys, and the General@ password entry, all at hidden prompts.

## Limits

- **Deleting the newest entries:** someone with root on the VM can still delete the newest audit entries together, or the whole file; the chain shows only changes before the newest entry. Copying the file off the VM (a backup) is the guard against that, and is not set up.
- **The TOTP secrets** are stored as they are, because the board must read them to check a code. A copy of `board.sqlite` alone does not sign anyone in: the password is needed too.
- **One process.** The sign-in limit per address is in memory and starts again on a restart.
- **Not built here:** the Docker image. This container has no Docker daemon. Each step was run by hand instead:
  - the frozen, filtered install;
  - `mail-deps.ts`;
  - loading the copied packages.
