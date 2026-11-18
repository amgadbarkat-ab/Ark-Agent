# BlackArk Control Board (#149)

One page for what BlackArk holds centrally about ArkAgent customers:
- the trial check-ins, licences and prepaid phone balances (from blackark.uk);
- the phone relay's health;
- GitHub issues and fixes;
- later, Stripe.

It shows that data; it does not change any of it. Each person has their own account, with
two-factor sign-in, and everything they do goes into an audit log. It is in English and Greek.

It is **not deployed**. Nothing here is live until Amgad says yes (see [Deploy](#deploy-for-coo-after-amgads-yes)).

```
browser ── https ──▶ Caddy (the relay's, on the EU VPS) ──▶ board:8080 (Bun, this folder)
                                                              │
     blackark.uk/checkin/export/ ◀── signed POST, signed answer ┤
     relay:8080/health           ◀── GET ───────────────────────┤
     api.github.com              ◀── read-only token, later ────┤
     Stripe                      ◀── restricted read key, later ┘
```

## What it keeps

**In its own SQLite file** (`data/board.sqlite`, on the VPS only):
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
  - account change;
  - refused request (wrong role, missing CSRF token).

  Each entry holds who did it, their role, the action, its target, the result and when.
- **Support cases:** each case's fields, and its internal notes as written. See [Support cases](#support-cases-milestone-2).

**What it does not keep:**
- **Customer data from the sources.** It is asked for at most once a minute and held in memory only.
- **IP addresses.** The caller's address is held in memory for 15 minutes, for the sign-in limit, and never written down.
- Anything from the customers' own computers.

## What it trusts

| From | Checked by |
|---|---|
| A person | user name, password (argon2id) **and** a TOTP code (RFC 6238, our own code on Bun's crypto), at every sign-in. A code is taken once. |
| A browser | the session cookie `__Host-ark_board`: `Secure; HttpOnly; SameSite=Strict; Path=/`, 15 minutes idle, 8 hours at most |
| A form | the session's CSRF token on every POST, and the browser's `Sec-Fetch-Site`/`Origin` must say it came from the board itself; the sign-in and setup forms use a pre-session token cookie |
| A role | `roles.ts`, on the server, for every page and action (table below) |
| blackark.uk's export | HMAC-SHA256 with `export_secret`, both ways: the request with a time, a nonce taken once and the body; the answer over its time, **our** nonce and the body. An answer for another request, an old one or one signed with another key is refused. |
| The relay | only its public `/health` answer (`ok`) |
| GitHub | a fine-grained token that can only read this repository's issues and PRs (later) |

It holds **no signing key**. Licences are signed only on Amgad's PC. If the board ever needs a
licence, it will only queue a request for Amgad to sign.

**Limits on signing in:**
- **One name:** 5 failures in 15 minutes lock that name for the rest of the 15 minutes, even with the right password and code. Unknown names are counted the same way, and every failure gets the same answer, so the board never tells which names exist.
- **One address:** 20 failures in 15 minutes stop it, across all names.

**Pages:** every page is sent with:
- a strict Content-Security-Policy (no scripts at all, styles only from the board);
- `X-Frame-Options: DENY` and `Cache-Control: no-store`;
- `noindex`.

Every value on a page is escaped.

### Roles

| | owner | admin | support | read-only |
|---|---|---|---|---|
| Overview, Customers, Services, Issues and fixes | yes | yes | yes | yes |
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
| **Overview** | installs; customers; on trial; paid; trial ends within 7 days; installs silent for 2 days; phone balances low; each service up, down or not connected |
| **Customers** | one row per customer id: installs (and how many are silent), version, plan or trial, days left, phone balance, last seen; filters matching the overview's counts |
| **Customer** | the installs, and a timeline: first and last check-ins, trial end, licence changes, phone credits, charges and write-offs, cases |
| **Services** | each source's state, detail and answer time |
| **Issues and fixes** | GitHub issues and PRs, by label, then open / merged / closed |
| **Audit log** | every entry, newest first, and whether the chain of entries is intact |
| **Accounts** | owners and admins add, disable and reset accounts |
| **Cases** | support cases, open or all; one case with its notes (milestone 2) |

**How a customer's plan is worked out:**
- **Paid:** an active licence, or an install that reports `paid`.
- **On trial:** otherwise, while an install reports a trial with days left.
- **Trial ended:** anything else.

The days left come from the install heard from most recently, because a silent install still reports the days it had then.

## Support cases (milestone 2)

**Cases are on** in this build. Each case has:
- a number and a customer id;
- a channel (in the app, email, phone) and a language (Greek, English);
- a priority, a status and an owner (a board account);
- an SLA due time;
- optionally, a linked GitHub issue;
- internal notes.

**The SLA** is the time to a first answer, worked out from the priority:

| Priority | Due within |
|---|---|
| urgent | 4 hours |
| high | 24 hours |
| normal | 72 hours |
| low | 7 days |

A case still new, open or waiting after that is marked **overdue**. Changing the priority works
the time out again from when the case was opened.

**Notes** are internal: the customer never sees them. A note is never changed or removed. The
audit log records that a note was added, and its length, never its text.

**GitHub:** a case links to an issue by its number. The board shows the link and never writes to
GitHub.

**A customer's page** lists their cases on the timeline, with **Open a case**.

**Roles:** read-only can read cases; support, admin and owner can also open and change them.

**Intake, design stage:** the code is built and tested against stand-ins, and is **not switched
on**. See `.scratch/control-board/intake-design.md`.
- **The app's future "Help & support" form:** `POST /intake/app`, signed like the export, opening
  an in-app case. It exists only when `INTAKE_SECRET` is set. Who signs (proposed: blackark.uk,
  after checking the install's signed profile) is an open question.
- **A support mailbox:** `pollMailbox` reads a `MailSource`, opens email cases and adds replies as
  notes. Only the in-memory stand-in exists. The IMAP client needs the mailbox, and Amgad's yes.

## Run it locally, with made-up data

```bash
bun infra/control-board/dev.ts
```

It prints the sign-in details and the current TOTP code every 30 seconds:
- **Address:** http://localhost:8787/login
- **User name:** `demo`
- **Password:** `demo-password-1`

Every source is a stand-in (`standins.ts`, customers `demo-…`). Nothing leaves the computer.

## Test

```bash
cd infra/control-board && bun test         # the board: TOTP, sign-in, lockout, sessions, CSRF, roles, audit, pages, sources, CLI, cases, intake
bash infra/blackark-checkin/test.sh        # the export on PHP: good, bad, stale and replayed signatures, no personal data
node_modules/.bin/tsc --noEmit -p infra/control-board
```

Run `bun test` from inside the folder: the repository root's `bunfig.toml` preloads the app's
test setup, which the board does not use.

## Deploy (for COO, after Amgad's yes)

The board runs on **the same EU VPS as the phone relay**. It joins the relay's Docker network, and the relay's Caddy serves it, because only one Caddy can hold ports 80 and 443.

1. **Amgad says yes** to:
   - this build;
   - the board's DNS name;
   - the relay change in step 4.
2. **DNS:** add an A record for the board's name, for example `board.blackark.uk`, pointing at the VPS.
3. **On the VPS:**
   ```bash
   cd Ark-Agent && git pull && cd infra/control-board
   ./deploy.sh setup        # asks for the domain; starts the board on the relay's network
   ```
4. **Caddy:** in `infra/phone-relay/`:
   - add the site from `Caddyfile.board` to the `Caddyfile`;
   - add `BOARD_DOMAIN: ${BOARD_DOMAIN}` under the caddy service's `environment` in `compose.yaml`;
   - add `BOARD_DOMAIN=<the name>` to the relay's `.env`;
   - run `docker compose up -d caddy`.

   This change goes in a reviewed PR, not by hand on the server.
5. **blackark.uk:**
   - make a secret with `php -r 'echo bin2hex(random_bytes(32));'`;
   - put it in `export_secret` in `checkin/config.php`;
   - upload `checkin/export/`.

   Then, on the VPS:
   ```bash
   ./deploy.sh checkin      # type the same secret at the hidden prompt
   ```
6. **The first owner**, Amgad himself, at the VPS's terminal:
   ```bash
   ./deploy.sh owner        # user name; password twice at a hidden prompt; adds the TOTP key; first code
   ```
   Amgad then adds the others on the **Accounts** page, and gives each their setup link himself.
7. **Check:**
   ```bash
   ./deploy.sh status       # ok
   ```
   Then sign in at `https://board.blackark.uk/` and look at **Services**.
8. **Later, each with its own yes:**
   - `./deploy.sh github`: a fine-grained read-only token;
   - the Stripe read key: not wired yet.

**Other commands:** `./deploy.sh reset <user> | unlock <user> | accounts | verify-audit | logs | restart | update`.

### Environment (`.env`, mode 600, written by `deploy.sh`)

| Variable | Example | Secret |
|---|---|---|
| `BOARD_DOMAIN` | `board.blackark.uk` | no |
| `BOARD_PUBLIC_ORIGIN` | `https://board.blackark.uk` | no; must be exactly the address people open |
| `CHECKIN_EXPORT_URL` | `https://blackark.uk/checkin/export/` | no |
| `CHECKIN_EXPORT_SECRET` | | **yes**: the same as `export_secret` on blackark.uk; hidden prompt |
| `RELAY_HEALTH_URL` | `http://relay:8080/health` | no |
| `GITHUB_REPO` | `amgadbarkat-ab/Ark-Agent` | no |
| `GITHUB_TOKEN` | | **yes**, later; hidden prompt |
| `INTAKE_SECRET` | | **yes**, later: switches on `POST /intake/app`. Unset: there is no such endpoint |
| `PORT`, `BOARD_DATA_DIR`, `TRUST_PROXY` | `8080`, `/data`, `1` (set in the image) | no |

**Images:** `oven/bun:1.3.14-slim`, the same as the relay. No package is installed.

**Outbound:** HTTPS to `blackark.uk`; later to `api.github.com`; HTTP to the relay on the Docker network.

## What Amgad must provide

- **A yes** on this build, and on the relay Caddy change (deploy step 4).
- **A DNS name** for the board (`board.blackark.uk` suggested).
- **The export secret.** He makes it (step 5); it goes into blackark.uk's `config.php` and the board's `.env` only.
- **The first owner account:** his own, at the VPS terminal, with his phone's authenticator app.
- **Later, each with its own yes:**
  - a fine-grained GitHub token: Issues read, Pull requests read, this repository only;
  - a Stripe restricted key, read-only;
  - for support cases, a support mailbox (milestone 2).

## Limits

- **Deleting the newest entries:** someone with root on the VPS can still delete the newest audit entries together, or the whole file; the chain shows only changes before the newest entry. Copying the file off the VPS (a backup) is the guard against that, and is not set up.
- **The TOTP secrets** are stored as they are, because the board must read them to check a code. A copy of `board.sqlite` alone does not sign anyone in: the password is needed too.
- **One process.** The sign-in limit per address is in memory and starts again on a restart.
