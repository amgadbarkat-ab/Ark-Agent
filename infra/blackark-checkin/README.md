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
