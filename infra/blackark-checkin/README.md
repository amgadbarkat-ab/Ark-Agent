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
- `'require_proof' => true` (the default from v0.1.57): check-ins without proof are refused. Every
  install has sent one since v0.1.38. Only signed installs count towards the "second install" flag.

If one.com's PHP has no sodium extension, signed check-ins are still stored, but they show as
unverified. You can check with a one-line `phpinfo()` file; delete it afterwards.

## Signed buy links (v0.1.57)

The buy page sends the customer id in its link to Stripe, and the licence key is signed for that id.
So from v0.1.57 a buy link comes from blackark.uk, signed, only after it checked the install's proof:

- the app asks `POST /checkin/buy/link/` with its install proof, and `servers/` and
  `support/priority/` answer with signed links too. A link works for 6 hours;
- `buy_link_secret` in `config.php` signs them (make it as `config.sample.php` says);
- `buy_requires_token`: while it is false, an unsigned link from an older app still works, and the
  Stripe webhook holds a purchase made under a customer id another payer already has (admin page,
  "Held purchases"). Set it to true once customers run v0.1.57. A top-up never needs a signed link;
- after the paid trial or licence has ended more than 30 days ago, a proof no longer opens Ark
  Private Server, 24/7 support or sub-profiles, unless the customer has an active licence here.
  Binding sub-profiles to an install the first time needs a proof that has not ended. A trial unlock
  code is never proof;
- the key page shows the key for 2 days after payment;
- renew, servers, 24/7 support and support replies are also limited per address (kept only as a
  keyed hash, for an hour).

**To switch on (COO, after Amgad's yes):** add `buy_link_secret` to the live `config.php`, set
`require_proof` to true there, upload `checkin/`, then check that
`curl -i -X POST https://blackark.uk/checkin/buy/link/ --data '{"customerId":"blackark-test","installId":"00000000-0000-4000-8000-000000000001"}'`
answers 403 (no proof), not 503 (no secret).

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

   # Must answer 403 (a check-in without a signed profile is refused)
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

## The BlackArk look (19 Nov 2026)

Every page a customer sees here (the tier page, the top-up thank-you, the refusals and the licence key
page) is in BlackArk's look, Amgad's standing rule of 19 Nov: blackark.uk's colours, Geist and Geist Mono,
the company's tile and favicons. They all come from `checkin/brand/`, which ships with the rest of
`checkin/`; nothing is loaded from another site, and the Content-Security-Policy allows styles, fonts and
images from this site only. The fonts and icons are the company's own files from the repository's `brand/`
(the tests check they have not drifted); `FONTS-LICENSE.txt` is Geist's SIL Open Font License, kept beside
the fonts and not served. Upload `brand/` with the pages; a page without it falls back to the system font.

## Ark Private Server (#149, 19 Nov 2026)

A private server BlackArk sets up for one customer to run an open model on. COO's five tiers, prices
approved by Amgad on 19 Nov 17:45 (#149 comment 7014144068), are in `checkin/servers-catalogue.php`
(denied to the web): what the app and the buy page show.

- **`…/checkin/servers/`** (POST, the install's own proof, as renew/ and support/): the tiers, the buy
  page's address, and this customer's latest order. Once staff have attached the server, the order
  carries its address, model and key, sent only to that customer's install. At most 60 requests an
  hour per install.
- **`…/checkin/buy/?customer=<id>&server=<tier>`**: a subscription Checkout with the tier's monthly price
  and, for the GPU tiers, the one-time activation as a second line. The prices are found **by lookup key**
  (`private_server_<tier>_monthly`, `_activation`) and checked against the catalogue: if Stripe's amount,
  currency or interval differs, nothing is sold (503) and the log says which. Back to
  `buy/?done=server`, in the BlackArk look.
- **The webhook**: a paid checkout with metadata `kind=private_server` becomes an order, "setting_up",
  in the `private_servers` table, never in `licenses`, so it signs no licence key. Each `invoice.paid`
  moves "paid until"; `customer.subscription.deleted` marks it cancelled and its key is no longer sent.
  The server log says "ark-server: new order …" for each new order.
- **Setting it up (by hand, phase 1)**: order the server from the supplier, install a runtime that serves
  an OpenAI-compatible API over HTTPS, then in `…/checkin/admin/` → "Ark Private Server orders" attach
  its address (ending in `/v1`), the model name it answers to and its key. The key is not shown again.
  "Mark stopped" if it is taken down. The customer's app shows "ready" within a few minutes, and one click
  makes it their model.

**One server per customer** (Amgad, 19 Nov 18:43): the order belongs to the customer id, so every
install of that customer sees it and can use it.

**Stripe:** the restricted key needs **Prices: Read** as well as Checkout Sessions: Write, to look the
prices up. The webhook events are the ones it already takes.

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
   - Add the endpoint `https://blackark.uk/checkin/stripe/` with these events (all six, from
     v0.1.49; Ark Private Server uses the same six):
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `invoice.paid`
     - `invoice.payment_failed`
     - `customer.subscription.updated` (a tier switch or a seat change in the billing portal)
     - `customer.subscription.deleted`
   - Copy its signing secret (`whsec_…`) into `'stripe_webhook_secret'`. Never post it.
3. **Each Payment Link:**
   - Set **After payment** to *Don't show confirmation page → redirect to*
     `https://blackark.uk/checkin/key/?session_id={CHECKOUT_SESSION_ID}`.
   - Send each customer the link with `?client_reference_id=<customer id>` added, so their key
     carries their id. Without it, the id becomes `stripe-<Stripe customer>`.
4. **In `'stripe_prices'`**, map each Stripe price id to a plan:
   - `'price_…' => ['plan' => 'team', 'seats' => 1, 'max_agents' => 10]` for a plan. The line's
     quantity is the seats; `max_agents` is Ark Team's tier, signed into the key;
   - `'price_…' => ['addon' => 'phone']` for the phone add-on sold as its own price.

**Keys after cancelling:** when a subscription is cancelled, no new key is made. The last key runs
out on its own, at its period end plus 7 days.

## Ark Team tiers (v0.1.49)

COO set these up live on 19 Nov. Each tier is its own product, so the billing portal
(`bpc_1UciZVKhgJyODeuaxWydSv0V`) can switch between them. EUR, per seat (one per person) a month,
tax exclusive. `config.sample.php` has all four in `'stripe_prices'`, and the three tiers in
`'stripe_buy' → 'tiers'`.

| Agents per seat | Price | Product | Price id |
|---|---|---|---|
| 5 | €100 | `prod_Vdzn1itHhHrV91` | `price_1Ud8FzKhgJyODeua2SX1TNos` |
| 10 | €140 | `prod_VeVI5ma2FGrmPR` | `price_1UdCIJKhgJyODeuaUPHF4RnX` |
| 20 | €200 | `prod_VeVIT7LAol18o2` | `price_1UdCIJKhgJyODeuaRpYa1gEb` |
| 5 (old single price, existing subscribers only) | €100 | | `price_1UchnkKhgJyODeuaDGI3UxBg` |

- **The key** carries `maxAgents` (5, 10 or 20) beside `seats`. The app allows `maxAgents × seats`
  digital employees on the computer. A key without `maxAgents` counts as 5.
- **A tier switch or a seat change** (`customer.subscription.updated`) signs a new key at once, for the
  same paid period. `…/checkin/renew/` hands it to an install that sends the old key's nonce.
- **A failed payment** (`invoice.payment_failed`): no new key until the next paid invoice. The last key
  runs out on its own.
- **The buy page** (`…/checkin/buy/?customer=<id>`) asks for the tier first. The old price is never
  offered there.
- **Not mapped:** `price_1Ud8G0KhgJyODeuauF67ovsh` and `price_1Ud8G1KhgJyODeuaA4eX9HPY`, deactivated
  on 19 Nov. A payment on a price not in the table changes nothing and is answered "not in the price
  table".

## Phone usage in Stripe's meters (v0.1.49)

**For the customer to see their usage only.** Billing stays the prepaid 5-hour blocks (EUR 23.40,
never below zero). The per-minute prices on the phone add-on are not charged.

- **When:** each time `…/checkin/phone/` books a call's charge, every part with minutes (`incoming`,
  `landline`, `mobile`) is queued as one meter event: `arkagent_phone_minutes_<part>`, with
  `payload[stripe_customer_id]`, `payload[value]` (whole minutes), and `identifier`
  `call_<call id>_<part>`, so a retry is counted once by Stripe.
- **Endpoint:** `POST https://api.stripe.com/v1/billing/meter_events`.
- **Key:** `'stripe_meter_key'` in `config.php`: a second restricted key with **Billing meter events:
  write** only. Never post it.
- **The Stripe customer:** the `cus_…` of the paid checkout (`session.customer`), now kept for every
  buyer, not only automatic top-up.
- **Never fatal:** without the key, without the customer, or with Stripe down, the event waits in
  `meter_events` and goes with a later call. The call and the balance are never affected. The export
  says how many wait (`meterEventsWaiting`), for the Control Board.
- **Customers who bought before v0.1.49** have no `cus_` kept unless they chose automatic top-up.
  Their events wait until one is known; see the open question in the v0.1.49 report.

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
3. Give the same secret to the board as a Worker secret, at wrangler's hidden prompt: `npx wrangler secret put CHECKIN_EXPORT_SECRET` (see `infra/control-board/README.md`).

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
2. Put it in `'intake_secret'`, and the board's address in `'intake_url'` (`https://<board>/intake/app`).
3. Give the same secret to the board: `npx wrangler secret put INTAKE_SECRET`.

**BlackArk's replies (Gap 3):** `…/checkin/support/replies/`, POST only.
- The app sends its install id and the same proof as a request (none before activation: customer
  `unverified`).
- This server checks the proof the same way, then asks the board's `/intake/replies` (`intake_url`
  with `/intake/app` replaced, or `intake_replies_url`), signed with `intake_secret`.
- It passes back only the case number, subject, status, opening time and the replies' time,
  language, text and English copy.
- Limit: 60 asks an hour per install. Only the install id and the time are kept, for an hour; never
  the internet address. The replies are never kept here.

## 24/7 Priority Support (Amgad, 24 Nov 2026)

- **`…/checkin/support/priority/`** (POST, with the install's own proof, as `servers/`) gives the app three things:
  - the offer (`ark_support_247_offer` in `lib.php`: EUR 100 a month, VAT excluded, the scope in Greek and English);
  - the customer's plan (active, past_due or cancelled);
  - the buy link.
- **`…/checkin/buy/?customer=<id>&support=247`** opens one subscription checkout.
  - The price is found by lookup key `arkagent_support_247_monthly_eur`, and must be EUR 100.00, monthly, `tax_behavior` exclusive. Otherwise it is not sold.
  - Stripe asks the name (billing address), the email and an optional company.
- **The webhook** keeps the plan in `support_plans`: subscription, customer id, status, dates. It never keeps the name, email or company.
  - Each change (`started`, `renewed`, `payment_failed`, `cancelled`) goes to the Control Board's `/intake/order`, signed with `intake_secret`, with the name, company and email on `started`.
  - When the board cannot take it, the message waits in `board_outbox` and goes on the next webhook, Help & support request or plan request. It is deleted once the board has it.

## The Control Board's audit copy (#149, not deployed)

The board copies its audit log here once a night (`AUDIT_COPY=blackark` on the board), so a copy is
kept away from Cloudflare.

**Endpoint:** `…/checkin/audit-copy/`, POST only, signed both ways like the export, with
`'audit_copy_secret'` (its own secret, not the export's or the relay's). Each nonce is taken once.

**Only a batch that continues the copy is taken:**
- it starts from the hash of an entry kept here (or from the start);
- its ids follow with no gap, and each entry's hash is recomputed here and must match;
- an entry kept already must come again exactly the same: the board may resend a batch whose answer
  it lost, but a changed entry is refused (409). The copy is never rewritten.

**Stored** in the `audit_copy` table of the same SQLite file. Its triggers refuse UPDATE and DELETE,
and nothing here issues either.

**What the entries hold:** staff user names and roles, the action, the customer id it was about, and
a short detail. No customer's name, email or words.

**Setup, once, after Amgad's yes:**
1. Make a secret with `php -r 'echo bin2hex(random_bytes(32));'`.
2. Put it in `'audit_copy_secret'` in `config.php`.
3. Give the same secret to the board: `npx wrangler secret put AUDIT_COPY_SECRET`, and set
   `AUDIT_COPY = "blackark"` and `AUDIT_COPY_URL = "https://blackark.uk/checkin/audit-copy/"` in its
   `wrangler.toml`.

Until then it answers 503.

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
