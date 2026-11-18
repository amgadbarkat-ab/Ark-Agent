# BlackArk trial check-in receiver (one.com)

A small PHP receiver for the daily trial check-in that ArkAgent installs send (#109), and a
password-protected status page. It runs on one.com shared hosting (PHP + Apache, no Bun or Node).

- `https://blackark.uk/checkin/`: where installs POST their check-in. Put this address, **with
  the trailing slash**, in each trial profile as `checkInUrl`.
- `https://blackark.uk/checkin/admin/`: the status page, behind a password.

## What it keeps

One row per install:
- customer id;
- a random install id;
- app version;
- trial status (trial / ended / paid);
- days left;
- end date;
- number of trial employees;
- whether the check-in carried a BlackArk-signed profile;
- first and last check-in, and the number of check-ins.

It keeps nothing else: no IP address, nothing a customer wrote, no names. The status page flags a
customer seen on more than one install in the last 7 days. It also marks an install not heard from
in 2 days.

## Proof that a check-in comes from a real trial

- **v0.1.37** sends the check-in without proof. These rows show as **unverified**.
- **From v0.1.38**, ArkAgent also sends the install's signed trial profile (`proof`). The receiver
  checks it with PHP's sodium extension against BlackArk's public key in `config.php`. It accepts a
  check-in only for the customer that the signature covers. These rows show as **verified**.
- Once every install runs v0.1.38 or later, set `'require_proof' => true`. Check-ins without
  proof are then refused.

If one.com's PHP has no sodium extension, signed check-ins are still stored, but they show as
unverified. You can check with a one-line `phpinfo()` file; delete it afterwards.

## Deploy (Site Admin packages, COO uploads only after Amgad's yes on this exact build)

1. **Make the password hash on your own computer**, never on the server:
   ```
   php -r 'echo password_hash(readline("Password: "), PASSWORD_DEFAULT), "\n";'
   ```
2. **Make the config file.** Copy `checkin/config.sample.php` to `checkin/config.php`, then:
   - put the hash into `admin_password_hash`;
   - leave `trial_public_keys` as it is (BlackArk's key, the same as in ArkAgent);
   - optionally set `data_dir` to a folder outside the web root, if one.com allows it. Otherwise
     keep `checkin/data/`, which `.htaccess` denies to the web.
3. **Upload** the whole `checkin/` folder to the blackark.uk web root, so that
   `…/checkin/index.php` exists. Use one.com File Manager, or SFTP (one.com Control Panel →
   SFTP/SSH; host and user name are shown there). Include the hidden `.htaccess` files: `checkin/`
   and `checkin/data/` each have one.
4. **Make `checkin/data/` writable** by PHP (permissions 755 or 775 in File Manager). The SQLite
   file is created on the first check-in.
5. **Force HTTPS** for blackark.uk in the one.com Control Panel, if it is not on already.
6. **Test**, from any computer:
   ```
   # Must answer 405 (only POST is allowed)
   curl -i https://blackark.uk/checkin/

   # Must answer 204 (stored)
   curl -i -X POST https://blackark.uk/checkin/ \
     -H 'content-type: application/json' \
     --data '{"customerId":"blackark-test","installId":"00000000-0000-4000-8000-000000000001","version":"test","status":"trial","daysLeft":30,"employees":0}'

   # Must answer 403 (denied, never the PHP source)
   curl -i https://blackark.uk/checkin/config.php
   curl -i https://blackark.uk/checkin/data/checkins.sqlite
   ```
   Then open `https://blackark.uk/checkin/admin/`, sign in, and look for the `blackark-test` row.

To remove the test row, delete `checkin/data/checkins.sqlite`. It is made again, empty, on the next
check-in.

## Limits

- One check-in per install every 5 minutes (`rate_limit_seconds`). Installs send one a day, and
  retry hourly after a failure.
- At most 2000 installs (`max_installs`).
- A body of at most about 700 KB, because a v0.1.38 proof carries the signed profile.
- After 10 wrong passwords in 15 minutes, the status page stops accepting sign-ins until the 15
  minutes pass.

## Test locally

Needs PHP 8 with pdo_sqlite and sodium, plus curl and bun. Nothing leaves the machine.

```
bash infra/blackark-checkin/test.sh
```

## Package

```
bash infra/blackark-checkin/package.sh   # writes blackark-checkin-<date>.zip, without config.php or data
```

## Paid licence keys after Stripe payment (v0.1.44)

Amgad said yes on 16 Nov. A customer pays through a Stripe Payment Link. Stripe tells this
receiver, which signs an ArkAgent licence key with BlackArk's **separate licence key**. The customer
copies the key from the page Stripe sends them to. Each month the app collects the renewed key by
itself.

**What is kept:** one row per subscription, with:
- the customer id;
- the Stripe subscription and checkout session ids;
- the plan, seats and add-ons;
- the period end;
- the latest key.

**What is not kept:** no card data, no name, no email, no address.

**Endpoints:**
- `…/checkin/stripe/`: Stripe's webhook. Each event is checked with `Stripe-Signature` (HMAC-SHA256
  with the webhook secret, timestamp within 5 minutes) and taken once.
- `…/checkin/key/?session_id=…`: the page after payment. It shows the key, in Greek and English.
- `…/checkin/renew/`: where the app asks once a day. It answers `{"key": …}` when a longer-lasting
  key exists for that customer, and `{}` otherwise.

**Setup, once.** Upload only after Amgad's yes on this exact build, as before.
1. **On Amgad's PC**, run `bun scripts/ark-trial.ts license-keygen`.
   - It writes `~/.arklicense/license-config.php.txt`, and prints only the public key.
   - Paste the two lines from that file into `checkin/config.php`, inside the array.
   - Post only the public key on #109, so it is built into the app.
2. **In Stripe** → Developers → Webhooks:
   - Add the endpoint `https://blackark.uk/checkin/stripe/` with the events
     `checkout.session.completed`, `invoice.paid` and `customer.subscription.deleted`.
   - Copy its signing secret (`whsec_…`) into `'stripe_webhook_secret'`. Never post it.
3. **Each Payment Link:**
   - Set **After payment** to *Don't show confirmation page → redirect to*
     `https://blackark.uk/checkin/key/?session_id={CHECKOUT_SESSION_ID}`.
   - Send each customer the link with `?client_reference_id=<customer id>` added, so their key
     carries their id. Without it, the id becomes `stripe-<Stripe customer>`.
4. **In `'stripe_prices'`**, map each Stripe price id to a plan:
   - `'price_…' => ['plan' => 'team', 'seats' => 1]` for a plan;
   - `'price_…' => ['addon' => 'phone']` for the phone add-on sold as its own price.

**Keys after cancelling:** when a subscription is cancelled, no new key is made. The last key runs
out on its own, at its period end plus 7 days.

## The buy page and the prepaid phone balance (v0.1.47)

Amgad decided on 17 Nov (#109 6945084979 and 6945455933):
- **One checkout for everything:** a buy page on blackark.uk opens one Stripe Checkout showing every price before payment.
- **Prepaid phone time:** the phone add-on comes with **5 prepaid hours**.
- **The last hour:** the customer is told and can buy 5 more, or have them bought automatically if they chose that at checkout.
- **Never negative:** the balance never goes below zero.

**The balance is money, not minutes.**
- **The 5-hour block:** EUR 23.40 excl. VAT, which is 5 hours at the incoming rate. It is credited as EUR 23.40.
- **What a call costs:** each part of a call takes off its own **whole minutes** at its own rate:

  | Part | Rate excl. VAT |
  |---|---|
  | incoming | EUR 0.078/min |
  | put through to a Greek landline (+302…) | EUR 0.088/min |
  | put through to any other number | EUR 0.139/min |

- **Units:** amounts are kept in mils (1/1000 euro), so every rate is a whole number.

| State | When | What callers get |
|---|---|---|
| `ok` | more than EUR 8.34 left (one hour at the mobile rate) | the employee answers |
| `low` | EUR 8.34 or less | the employee answers. The app shows **Add 5 hours**, the email is sent if switched on, and an automatic top-up starts if chosen |
| `empty` | less than one incoming minute (EUR 0.078) | **not answered**: a busy tone, which Twilio does not bill |

**Never below zero.** The phone relay sets each minute's cost aside **before** the minute starts, across all of a customer's live calls:
- **The rate set aside:** the incoming rate, plus the landline or mobile rate once the caller is put through to a person.
- **When the next minute can't be paid:** the caller hears one sentence and the call ends before that minute starts: «Ο διαθέσιμος χρόνος της γραμμής τελείωσε. Παρακαλούμε καλέστε ξανά αργότερα.» ("The line's available time has run out. Please call again later.")
- **If this server can't be reached**, the relay answers **one** call per customer on the last balance it knew, then busy until this server answers again. It also sends BlackArk one internal alert. That call's cost beyond what is booked is BlackArk's.
- **The last line of defence, here:** a charge never takes the balance below zero. If Twilio ever reports more than was left, the rest is **written off** at BlackArk's cost, in the ledger row's `written_off_mils`, and logged.

**Automatic top-up (optional, off by default):**
- **Opting in:** at checkout the customer can pick "Ναι" ("Yes") under «Αυτόματη προσθήκη 5 ωρών τηλεφωνίας» ("Automatic addition of 5 phone hours").
- **When it charges:** when `low` starts, this server asks Stripe for an invoice of one block on the subscription. It is charged to the saved card, with VAT added the same way.
- **When it's credited:** on `invoice.paid`.
- **How often:** one attempt per block. A declined card leaves the app's notice and button.

**Unused balance is not refunded** on cancellation (Amgad).

**What is kept**, beyond the licence rows:
- **Per customer:**
  - the balance;
  - whether automatic top-up was chosen, and the Stripe customer id it needs;
  - the billing **country**, only to choose the low-balance email's language.
- **One ledger row per credit or charge**, with:
  - the customer id;
  - a reference: the Stripe checkout session or invoice, or the Twilio call id and part;
  - the kind;
  - the minutes;
  - the amount;
  - anything written off.
- **Never kept:** the caller's number. It never reaches this server.
- **The customer's email:** kept only while the low-balance email is switched on, and only to send it.

**Endpoints:**
- `…/checkin/buy/?customer=<id>&phone=1`: the team plan, the phone add-on and the first 5-hour block, with the automatic top-up choice, in one Stripe Checkout.
  - Without `phone=1`: the plan alone.
  - After paying, Stripe returns to the key page.
- `…/checkin/buy/?customer=<id>&topup=1`: one more 5-hour block, as a one-off payment. Only for a customer who has the phone add-on.
- `…/checkin/phone/`: only the phone relay calls this.
  - What it does: answers the balance and the rates, or takes a call's charges.
  - Signing: each request is signed with the shared `relay_secret` (`X-Ark-Time`, and `X-Ark-Signature` = HMAC-SHA256 of `<time>.<body>`, within 5 minutes).
  - No double charges: each part of a call is charged once, keyed by Twilio's call id and the part.
- `…/checkin/stripe/` also credits a block for:
  - a paid checkout from the buy page: `checkout.session.completed` with payment status `paid`, or `checkout.session.async_payment_succeeded`;
  - a paid automatic top-up invoice: `invoice.paid` with metadata `kind=phone_topup`.

  Each is credited once.

**Setup, once, after Amgad's yes on this exact build:**
1. **In Stripe**, create a one-off price "Phone: 5 hours" at EUR 23.40.
2. **In Stripe**, create a **restricted key** with:
   - Checkout Sessions: write;
   - for automatic top-up, also Invoices: write and Customers: read.
3. **In `config.php`:**
   - Put that key in `'stripe_api_key'`. Never post it.
   - Put the three price ids in `'stripe_buy'` (`plan`, `phone`, `block`).
   - Make a secret with `php -r 'echo bin2hex(random_bytes(32));'` and put it in `'relay_secret'`.
4. **In Stripe → Webhooks**, add the event `checkout.session.async_payment_succeeded` to the existing endpoint. `invoice.paid` is already there.
5. **On the relay server**, enable billing and bill each line:

   ```bash
   ./deploy.sh billing                          # type the same secret at the hidden prompt
   ./deploy.sh bill-line <line> <customer-id>   # billed from that customer's balance
   ```

   A line that is not billed (a demo or trial line) works as before.
6. **Send customers** `https://blackark.uk/checkin/buy/?customer=<id>&phone=1` instead of a Payment Link.

**The low-balance email (approved by Amgad, 17 Nov 12:53).**
- **When it is sent:** once, when the last hour starts. Again only after a top-up.
- **Sender:** `no-reply@blackark.uk`, with Reply-To `General@blackark.uk`.
- **Where the text is:** `checkin/phone-emails.php`, exactly as approved, which is denied to the web.
- **Language rule:**

  | Customer's country | The email |
  |---|---|
  | Greece, Cyprus | Greek first, then the English copy |
  | GCC (AE, SA, QA, KW, BH, OM) | English only |
  | any other country | the English text, and the server log names the country |

- **Adding a language:** a new text is added to `phone-emails.php` in a pull request, and is used only after Amgad's yes on that text.
- **Switching it on:** it is off (`'phone_low_email' => false`) until Amgad's yes at deploy. The app's notice works without it.

## The Control Board's export (#149, not deployed)

A read-only endpoint for the BlackArk Control Board (`infra/control-board/`). It changes nothing.
Upload it only with Amgad's yes on this exact build, as before.

**Endpoint:** `…/checkin/export/`, POST only.

**Signing, both ways**, with `'export_secret'` in `config.php`, a separate secret from `relay_secret`:
- **The request:**
  - `X-Ark-Time`: the Unix time, accepted within 5 minutes;
  - `X-Ark-Nonce`: new for each request;
  - `X-Ark-Signature`: HMAC-SHA256 of `<time>.<nonce>.<body>`.
- **Replays:** each nonce is taken once, so the same request sent again is refused (409).
- **The answer** is signed the same way over `<time>.<nonce>.<answer>`, so the board knows it came from here, for its own request.

**What it returns:**
- **installs:** the check-in rows;
- **licences:** plan, seats, add-ons, active or canceled, period end;
- **phone:** each balance and its state;
- **ledger:** the last 90 days of credits and charges.

**Never in it:**
- an IP address (none is kept);
- a name, an email or a billing country;
- a licence key or a Stripe id;
- a ledger reference (a Twilio call id).

**Setup, once, after Amgad's yes:**
1. Make a secret with `php -r 'echo bin2hex(random_bytes(32));'`.
2. Put it in `'export_secret'` in `config.php`.
3. Type the same secret at the board's hidden prompt (`./deploy.sh checkin`, in `infra/control-board/`).

Until then the export answers 503.

## Help & support from the app (#149, not deployed)

Amgad decided on 18 Nov: in-app Help & support is BlackArk's only support channel.

**Endpoint:** `…/checkin/support/`, POST only.

**What it does with a request:**
1. **Checks the proof.** The request must carry the install's BlackArk-signed proof, either:
   - the trial profile (checked as for check-ins); or
   - its `ARK1-` activation code or licence key, checked against `trial_public_keys` or `license_public_key`, for this customer.
2. **Limits it:** 10 requests per install a day.
3. **Adds the plan:** `paid` while an active licence is on file, otherwise `trial`.
4. **Forwards it** to the Control Board (`intake_url`), signed with `intake_secret`: `X-Ark-Time`, `X-Ark-Nonce`, and `X-Ark-Signature` = HMAC-SHA256 of `<time>.<nonce>.<body>`. The proof itself is not forwarded.
5. **Answers** the board's case number: `{"case": 7}`.

**If the board cannot be reached:** it answers 502. The app keeps the request and sends it again every hour, with the same request id, so it becomes one case.

**What is kept here:** only the install id, the request id and the time, for the daily limit, for 24 hours. The customer's words and any diagnostics pass through to the board.

**Setup, once, after Amgad's yes:**
1. Make a secret with `php -r 'echo bin2hex(random_bytes(32));'`.
2. Put it in `'intake_secret'`, and the board's address in `'intake_url'`.
3. Type the same secret at `./deploy.sh intake` on the board.

## Counts in the check-in (v0.1.49, #149)

From v0.1.49 the app's check-in may also carry **counts only**, all optional:

| Field | What it is |
|---|---|
| `people` | people with an account on that install |
| `activePeople7d` | how many of them used it in the last 7 days; never more than `people` |
| `conversations7d` | conversations started in the last 7 days |
| `phoneLine` | `true` or `false`: whether a phone line is set up |
| `os` | `windows`, `macos` or `linux` |

**Storage:** they are stored in new columns, added once to an existing file, and they are in the export.

**Older installs:** send none, and show `–`.

**Anything else** in a check-in, a name for example, is still refused.
