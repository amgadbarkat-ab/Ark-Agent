# Customer trials (#109)

How BlackArk sets up, changes and ends a customer trial of the ArkAgent desktop app (v0.1.37 on).

## Once: the signing key

On the signing computer (Bun needed), from a checkout of this repository:

```
bun scripts/ark-trial.ts keygen
```

The private key goes to `~/.arktrial/ark-trial-private.pem`, readable by you only, and is never
printed. Keep it and one offline backup. Only the printed PUBLIC key is shared: it goes into
`shared/trial-public-key.ts`, and every build from then on trusts it. Running keygen again does not
replace an existing key.

## Per customer: the profile

1. Write the draft, as in `profile-draft-example.json`:
   - `customer.id`: lower-case letters, digits and hyphens. Unlock codes name this.
   - `startsAt` / `endsAt`: fixed instants, with the Athens offset.
   - `plan`: `team`.
   - `createBlocked`: `true`.
   - `addons`: paid add-ons the customer has paid for, for example `["phone"]` (answering the
     business's phone line). Leave it out until the customer has paid: without it the add-on is
     off on that install, its settings are hidden and nothing connects.
   - `checkInUrl`: `https://<BlackArk server>/api/trial-checkins`, or leave it out.
   - `roster`: per employee, `key`, `name`, `title`, `roleDescription` (600 characters at most),
     `instructions`, and optionally `basedOn` (an official role's slug, which brings its skills) and
     `lead: true`. Also optionally, per employee:
     - `mail`: `{ "folders": [...], "from": "..." }` gives it the business's mailbox (v0.1.38);
     - `priceList: true` gives it `find_price`, the business's uploaded price list (v0.1.40). Its
       instruction should say: prices only from `find_price`; if it says the prices are not loaded,
       say so and give none;
     - `video: true` gives it video editing on that computer (v0.1.40), for example a social-media
       content employee.
2. `bun scripts/ark-trial.ts sign-profile demo-shop.json` writes `demo-shop.arktrial`.
3. `bun scripts/ark-trial.ts show demo-shop.arktrial --public-key <public key>` prints what it says and
   whether the key signed it.
4. On the customer's computer: setup window → **Import trial profile**, or after setup
   **Settings → Plan → Trial → Import trial profile → Choose file**.

Official role slugs for `basedOn` (the tool refuses any other): `sales`, `front-desk`, `marketing`,
`accounting`, `support-agent` (Customer Support), `inventory-logistics`, `executive-assistant`
(Personal Secretary), `operations-coordinator` (Chief of Operations), `sales-engineer`,
`finance-assistant` (Finance), `programmer`, `chief-of-staff`, `designer`, `coding-engineer`,
`code-reviewer`, `research-analyst`, `writing-editor`. An employee with no `basedOn` is a custom one:
its standing instruction is all it has.

## Afterwards: unlock codes

```
bun scripts/ark-trial.ts sign-code --customer demo-shop --action extend --until 2027-01-15T23:59:59+02:00
bun scripts/ark-trial.ts sign-code --customer demo-shop --action end
bun scripts/ark-trial.ts sign-code --customer demo-shop --action paid
```

The customer pastes the printed `ARK1-…` line into **Settings → Plan → Trial → Unlock code**. Each
code works once, and only for its customer.

## Check-ins

BlackArk's own ArkAgent server, with `ARK_TRIAL_RECEIVER=true`, receives check-ins at
`/api/trial-checkins` and lists them in **Admin → Trials**. Each one carries the customer id, a
random install id, the version, the status, the days left, the end and the number of trial
employees. Nothing else is sent.

## Activation (from v0.1.42)

The desktop app opens only with one of three things:

- the trial setup file above;
- a **trial activation code**;
- a **paid licence key**.

Without one of them, the **Activate ArkAgent** screen is the only screen.

```
# A trial without a setup session: opens ArkAgent until that moment, on any computer.
bun scripts/ark-trial.ts sign-trial-code --customer demo-shop --until 2026-12-17T23:59:59+02:00 [--plan team] [--addons phone]

# Paid: valid until the period end plus 7 days' grace. --renew-url is where the app asks daily.
bun scripts/ark-trial.ts sign-license --customer demo-shop --period-end 2026-12-17 --seats 1 [--plan team] [--addons phone] [--renew-url https://…]

bun scripts/ark-trial.ts show ARK1-… --public-key <base64>
```

**Where to enter them:** the person types the printed `ARK1-…` line on the Activate screen, or later
in **Settings → Plan → Activation**. The same box also takes the unlock codes above.

**Which key signs what:**

- **Trial activation codes:** the trial key.
- **Licence keys:** the keys in `shared/license-public-key.ts`. Today that is the trial key. A
  separate licence key for the payment server is a later step:
  1. Make it with `keygen --dir ~/.arklicense`.
  2. Add its public half to that file.
  3. Remove the trial key from that file in a later release.

**What the server refuses:**

- a code or key that BlackArk did not sign;
- a code or key for another customer than the one the computer is set up for;
- a code or key whose end has already passed;
- a trial code on a computer that has a paid licence;
- a licence key that ends sooner than the one already entered.

**Typing a key twice:** entering the same licence key again changes nothing.

**Renewal:** the app POSTs `{customerId, installId, version, nonce, validUntil}` to the key's
`renewUrl` once a day. If the answer is `{"key": "ARK1-…"}` with a newer signed licence key for the
same customer, the app takes it. If the answer is `{}`, nothing changes.

## Shop and delivery connectors (from v0.1.43)

Every install has them, under **Settings → Connect your Data → Shop and delivery**. At the setup
session, type in the customer's own details:

| Connector | What to type | Where the customer gets it |
|---|---|---|
| Skroutz | API token; optionally the order inbox address and key | Skroutz merchant panel → Merchants → Services → Skroutz Marketplace. The inbox comes from BlackArk's `…/checkin/admin/skroutz.php` |
| WooCommerce | shop address, consumer key and secret | WordPress → WooCommerce → Settings → Advanced → REST API |
| BOX NOW | API address (API_URL), client id, client secret | BOX NOW, after partner registration; stage first |
| Business data files | upload each export under a short name (`stock`, `items`, `customers`) | Pylon's own export to Excel/CSV |

**Which employee gets which connector** goes in the setup file, per employee:

```json
"connectors": ["skroutz", "boxnow", "business-files"]
```

## ELTA Courier and competitor prices (from v0.1.44)

**ELTA Courier:** in **Settings → Connect your Data → Shop and delivery**, type in the customer code,
user code and password that ELTA Courier gives a contract customer for its web service. Leave the
service address empty unless ELTA gives another one.

**Competitor prices:**
1. **Upload the watch list** as a business data file named `price-watch`, for example:
   ```
   Προϊόν;SKU;Our price;Skroutz;BestPrice
   Λευκό κρασί 750ml;W-101;15,90 €;https://www.skroutz.gr/s/…;https://www.bestprice.gr/item/…
   ```
2. **Give the employee** the tools "Competitor prices", "Business data files" and, for price
   changes, WooCommerce. In the setup file: `"connectors": ["price-watch", "business-files", "woocommerce"]`.
3. **Add a Routine** for that employee, daily or hourly as the customer chooses, for example:
   «Κάθε πρωί: διάβασε τη λίστα παρακολούθησης, άνοιξε μία μία τις σελίδες, κατέγραψε τις τιμές
   και στείλε μου την αναφορά. Αν μια τιμή μας είναι ακριβότερη, πρότεινε νέα τιμή για έγκριση.»
   ("Every morning: read the watch list, open the pages one by one, record the prices and send me
   the report. If one of our prices is higher, propose a new price for approval.")

**The rules for the employee:**
- one page at a time;
- it stops at any CAPTCHA or block;
- every price change waits on an approval card.

**Skroutz's terms:** they forbid monitoring the site without written permission. BlackArk asks
Skroutz first (Amgad, 16 Nov).
