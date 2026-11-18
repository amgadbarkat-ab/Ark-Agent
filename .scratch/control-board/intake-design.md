# Support case intake: design (#149, milestone 2)

Status: open (design; code exists and is tested, nothing is switched on)

## 1. The app's "Help & support" form → `POST /intake/app`

**Board side (built, `intake.ts`, mounted only when `INTAKE_SECRET` is set):**
- **Signing:** HMAC-SHA256 with `INTAKE_SECRET`, over `<time>.<nonce>.<body>`, sent as
  `X-Ark-Time`, `X-Ark-Nonce`, `X-Ark-Signature`. The same scheme as the check-in export.
- **Window and replays:** within 5 minutes; each nonce is taken once (`intake_nonces`, and the
  case's `source_ref = app:<nonce>`).
- **Body:**
  `{customerId, installId, appVersion, language: "el"|"en", subject (≤200), message (≤8000)}`.
- **What it does:** opens one case: channel in-app, priority normal, status new, with the message
  as the first internal note. It is audited as `intake:app`.
- **Limit:** 20 in-app cases per customer per 24 hours. More answers 429.

**The open question: who holds the secret?** A shared secret built into every copy of the app can
be read out of the app, so anyone could then open cases. Proposed instead:

```
app ──(signed trial profile or licence, like the check-in proof)──▶ blackark.uk/checkin/support/
blackark.uk ──(HMAC with intake_secret, the board's scheme above)──▶ board /intake/app
```

- **blackark.uk** already checks the install's BlackArk-signed profile for check-ins
  (`ark_proof_ok`). It would check the same proof here, rate-limit per install, and forward the
  request signed. The secret then lives only on blackark.uk and the board.
- **The app** needs one new call, to an address it already trusts.
- **The PHP endpoint** is not written. It is small, and follows `checkin/phone/index.php`.

**The alternative:** the board pulls queued requests from blackark.uk, so the board has no public
intake endpoint at all. It is safer, but slower, at once a minute.

## 2. The support mailbox → an IMAP poller

**Built (`intake.ts`):**
- **The interface:** `MailSource` (`unseen()`, `markSeen(id)`), with an in-memory stand-in.
- **`pollMailbox`:**
  - **A reply** becomes a note on its case. It is matched by `In-Reply-To` a message we took, or
    `[Case #N]` / `[Υπόθεση #N]` in the subject.
  - **Anything else** opens an email case, with the customer id from `[customer:<id>]` in the
    subject, or `unmatched` for a person to set.
  - **Language:** Greek letters mean el.
  - **Once only:** each Message-ID is taken once.

**Not built (needs the mailbox and Amgad's yes):**
- **The real IMAP client:** IMAP over TLS to the one.com mail server (`imap.one.com:993`), on Bun's
  `tls` socket. The commands: `LOGIN`, `SELECT INBOX`, `UID SEARCH UNSEEN`,
  `UID FETCH <uid> (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO FROM SUBJECT)] BODY.PEEK[TEXT])`,
  `UID STORE <uid> +FLAGS (\Seen)`. Plain text and quoted-printable/base64 text parts only;
  attachments are dropped and noted.
- **How often:** every 2 minutes, from the board's process.
- **The mailbox password:** in `.env` (mode 600), at a hidden prompt (`./deploy.sh mailbox`).
- **Replies to customers** are not designed here. Sending from the board would be a new outbound
  service.

**Personal data:** the sender's address and the text are kept in the case's first note. Both are
the customer's own message to support. Retention for case notes (for example, deleting closed cases
after N months) is a decision for Amgad. Today, notes are never changed or removed.

## 3. Cases on the board (built, `cases.ts`)

- **What a case holds:** a number, customer id, channel, language, priority, status, owner, SLA due
  time, subject, an optional GitHub issue, and append-only internal notes.
- **SLA from the priority:**

  | Priority | First answer within |
  |---|---|
  | urgent | 4 hours |
  | high | 24 hours |
  | normal | 72 hours |
  | low | 7 days |

  These are calendar hours. Whether they should be business hours (Athens) is open.
- **Overdue:** a case still new, open or waiting after its due time.
- **Linking a GitHub issue:** by number. The board shows the link; it never writes to GitHub.
